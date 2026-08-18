-module(chat_ws).

-export([init/2, websocket_init/1, websocket_handle/2, websocket_info/2, terminate/3]).

-define(MAX_MESSAGE_CHARS, 4000).
-define(AUTH_TIMEOUT_MS, 5000).
-define(WS_OPTS, #{idle_timeout => 600000, max_frame_size => 262144}).

init(Req, _State) ->
    Qs = cowboy_req:parse_qs(Req),
    GroupId = parse_group_id(proplists:get_value(<<"group">>, Qs, <<"1">>)),
    case header_token(Req) of
        <<>> ->
            {cowboy_websocket, Req, #{pending_auth => true, group_id => GroupId}, ?WS_OPTS};
        Token ->
            case authenticate(<<>>, Token, GroupId) of
                {ok, Username} ->
                    {cowboy_websocket, Req, #{username => Username, group_id => GroupId}, ?WS_OPTS};
                {error, not_member} ->
                    reject(Req, 403, <<"{\"error\":\"Not a member of this group\"}">>);
                {error, _Reason} ->
                    reject(Req, 401, <<"{\"error\":\"Invalid or expired token\"}">>)
            end
    end.

reject(Req, Status, Body) ->
    Req2 = cowboy_req:reply(Status, #{
        <<"content-type">> => <<"application/json">>
    }, Body, Req),
    {ok, Req2, #{}}.

header_token(Req) ->
    case cowboy_req:header(<<"authorization">>, Req, <<>>) of
        <<"Bearer ", Rest/binary>> -> Rest;
        <<"bearer ", Rest/binary>> -> Rest;
        _ -> <<>>
    end.

websocket_init(#{pending_auth := true} = State) ->
    erlang:send_after(?AUTH_TIMEOUT_MS, self(), auth_timeout),
    {ok, State};
websocket_init(#{username := Username, group_id := GroupId} = State) ->
    start_session(Username, GroupId, State).

start_session(Username, GroupId, State) ->
    case chat_clients:join(self(), Username, GroupId) of
        ok ->
            {Replies, NewState} = connected_replies(Username, GroupId, State),
            {reply, Replies, NewState};
        {error, group_full} ->
            Max = chat_config:max_group_users(),
            Payload = jsone:encode(#{
                type => group_full,
                error => <<"Group is full">>,
                max_users => Max,
                group_id => GroupId
            }),
            {stop, {reply, [{text, Payload}], State}}
    end.

connected_replies(Username, GroupId, State) ->
    {Users, IsNew} = chat_redis:mark_online(Username, GroupId),
    List = jsone:encode(#{type => online_list, users => Users, group_id => GroupId}),
    Replies = case IsNew of
        true ->
            chat_redis:publish(chat_config:chat_channel(),
                jsone:encode(#{type => online, username => Username, group_id => GroupId})),
            [{text, List}];
        false ->
            [{text, List}]
    end,
    Clean = maps:remove(pending_auth, State#{username => Username, group_id => GroupId}),
    {Replies, Clean}.

websocket_handle({text, Raw}, #{pending_auth := true, group_id := GroupId} = State) ->
    try jsone:decode(Raw, [{object_format, map}]) of
        #{<<"type">> := <<"auth">>} = Auth ->
            Ticket = maps:get(<<"ticket">>, Auth, <<>>),
            Token = maps:get(<<"token">>, Auth, <<>>),
            case authenticate(Ticket, Token, GroupId) of
                {ok, Username} ->
                    start_session(Username, GroupId, State);
                {error, not_member} ->
                    Payload = jsone:encode(#{type => error, error => <<"Not a member of this group">>}),
                    {stop, {reply, [{text, Payload}], State}};
                {error, _Reason} ->
                    Payload = jsone:encode(#{type => error, error => <<"Invalid or expired token">>}),
                    {stop, {reply, [{text, Payload}], State}}
            end;
        _ ->
            {ok, State}
    catch
        _:_ ->
            {ok, State}
    end;
websocket_handle({text, Raw}, #{username := Username, group_id := GroupId} = State) ->
    try jsone:decode(Raw, [{object_format, map}]) of
        #{<<"type">> := <<"auth">>} ->
            {ok, State};
        #{<<"type">> := <<"typing">>} ->
            chat_redis:publish(chat_config:chat_channel(),
                jsone:encode(#{type => typing, username => Username, group_id => GroupId})),
            {ok, State};
        #{<<"type">> := Type} = Call when
                Type =:= <<"call_invite">>;
                Type =:= <<"call_accept">>;
                Type =:= <<"call_reject">>;
                Type =:= <<"call_hangup">>;
                Type =:= <<"call_offer">>;
                Type =:= <<"call_answer">>;
                Type =:= <<"call_ice">>;
                Type =:= <<"call_sfu_answer">> ->
            publish_call(Type, Call, Username, GroupId),
            {ok, State};
        #{<<"type">> := Type} = Receipt when Type =:= <<"viewed">>; Type =:= <<"delivered">> ->
            case receipt_ids(Receipt) of
                [] ->
                    {ok, State};
                Ids ->
                    chat_redis:publish(chat_config:inbound_channel(),
                        jsone:encode(#{
                            type => Type,
                            username => Username,
                            group_id => GroupId,
                            ids => Ids
                        })),
                    {ok, State}
            end;
        Payload ->
            case maps:get(<<"message">>, Payload, undefined) of
                Message when is_binary(Message), Message =/= <<>> ->
                    case message_ok(Message) of
                        true ->
                            Inbound = jsone:encode(#{
                                username => Username,
                                message => Message,
                                group_id => GroupId
                            }),
                            chat_redis:publish(chat_config:inbound_channel(), Inbound),
                            {ok, State};
                        false ->
                            {ok, State}
                    end;
                _ ->
                    {ok, State}
            end
    catch
        _:_ ->
            {ok, State}
    end;
websocket_handle(_Frame, State) ->
    {ok, State}.

websocket_info(auth_timeout, #{pending_auth := true} = State) ->
    {stop, State};
websocket_info(auth_timeout, State) ->
    {ok, State};
websocket_info({chat, Payload}, State) ->
    {reply, {text, Payload}, State};
websocket_info(_Info, State) ->
    {ok, State}.

terminate(_Reason, _Req, #{username := Username, group_id := GroupId}) ->
    case chat_redis:mark_offline(Username, GroupId) of
        true ->
            chat_redis:publish(chat_config:chat_channel(),
                jsone:encode(#{type => offline, username => Username, group_id => GroupId}));
        false ->
            ok
    end,
    ok;
terminate(_Reason, _Req, _State) ->
    ok.

authenticate(Ticket, Token, GroupId) when is_binary(Ticket), Ticket =/= <<>> ->
    case chat_redis:consume_ticket(Ticket) of
        {ok, Username} -> member_or_error(Username, GroupId);
        _ -> authenticate(<<>>, Token, GroupId)
    end;
authenticate(_Ticket, Token, GroupId) ->
    case chat_jwt:verify(Token, chat_config:secret_key()) of
        {ok, Username} -> member_or_error(Username, GroupId);
        Error -> Error
    end.

member_or_error(Username, GroupId) ->
    case chat_redis:is_member(GroupId, Username) of
        true -> {ok, Username};
        false -> {error, not_member}
    end.

message_ok(Message) ->
    case unicode:characters_to_list(Message) of
        List when is_list(List) -> length(List) =< ?MAX_MESSAGE_CHARS;
        _ -> false
    end.

publish_call(Type, Msg, Username, GroupId) ->
    CallId = maps:get(<<"call_id">>, Msg, <<>>),
    case is_binary(CallId) andalso byte_size(CallId) > 0 andalso byte_size(CallId) =< 80 of
        false ->
            ok;
        true ->
            Out = #{
                type => Type,
                call_id => CallId,
                from => Username,
                username => Username,
                group_id => GroupId
            },
            Out1 = copy_optional(Msg, Out, [
                {<<"to">>, to},
                {<<"media">>, media},
                {<<"sdp">>, sdp},
                {<<"candidate">>, candidate}
            ]),
            chat_redis:publish(chat_config:chat_channel(), jsone:encode(Out1))
    end.

copy_optional(_Src, Dest, []) ->
    Dest;
copy_optional(Src, Dest, [{BinKey, AtomKey} | Rest]) ->
    case maps:get(BinKey, Src, undefined) of
        undefined -> copy_optional(Src, Dest, Rest);
        Value -> copy_optional(Src, Dest#{AtomKey => Value}, Rest)
    end.

parse_group_id(Value) when is_integer(Value), Value > 0 ->
    Value;
parse_group_id(Value) when is_binary(Value) ->
    try binary_to_integer(Value) of
        Id when Id > 0 -> Id;
        _ -> 1
    catch
        _:_ -> 1
    end;
parse_group_id(_) ->
    1.

receipt_ids(Payload) ->
    Raw = case maps:get(<<"ids">>, Payload, undefined) of
        List when is_list(List) -> List;
        _ ->
            case maps:get(<<"id">>, Payload, undefined) of
                Id when is_integer(Id) -> [Id];
                Id when is_binary(Id) -> [Id];
                _ -> []
            end
    end,
    lists:sublist(Raw, 50).
