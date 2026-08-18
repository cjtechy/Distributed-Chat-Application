-module(chat_ws).

-export([init/2, websocket_init/1, websocket_handle/2, websocket_info/2, terminate/3]).

init(Req, _State) ->
    Qs = cowboy_req:parse_qs(Req),
    Token = proplists:get_value(<<"token">>, Qs, <<>>),
    case chat_jwt:verify(Token, chat_config:secret_key()) of
        {ok, Username} ->
            {cowboy_websocket, Req, #{username => Username}, #{
                idle_timeout => 600000,
                max_frame_size => 65536
            }};
        {error, _Reason} ->
            Req2 = cowboy_req:reply(401, #{
                <<"content-type">> => <<"application/json">>
            }, <<"{\"error\":\"Invalid or expired token\"}">>, Req),
            {ok, Req2, #{}}
    end.

websocket_init(#{username := Username} = State) ->
    chat_clients:join(self(), Username),
    {Users, IsNew} = chat_redis:mark_online(Username),
    List = jsone:encode(#{type => online_list, users => Users}),
    Replies = case IsNew of
        true ->
            chat_redis:publish(chat_config:chat_channel(),
                jsone:encode(#{type => online, username => Username})),
            [{text, List}];
        false ->
            [{text, List}]
    end,
    {reply, Replies, State}.

websocket_handle({text, Raw}, #{username := Username} = State) ->
    try jsone:decode(Raw, [{object_format, map}]) of
        #{<<"type">> := <<"typing">>} ->
            chat_redis:publish(chat_config:chat_channel(),
                jsone:encode(#{type => typing, username => Username})),
            {ok, State};
        Payload ->
            case maps:get(<<"message">>, Payload, undefined) of
                Message when is_binary(Message), Message =/= <<>> ->
                    Inbound = jsone:encode(#{
                        username => Username,
                        message => Message
                    }),
                    chat_redis:publish(chat_config:inbound_channel(), Inbound),
                    {ok, State};
                _ ->
                    {reply, {text, error_json(<<"Send JSON like {\"message\": \"Hello everyone\"} or {\"type\": \"typing\"}">>)}, State}
            end
    catch
        _:_ ->
            {reply, {text, error_json(<<"Invalid JSON">>)}, State}
    end;
websocket_handle(_Frame, State) ->
    {ok, State}.

websocket_info({chat, Payload}, State) ->
    {reply, {text, Payload}, State};
websocket_info(_Info, State) ->
    {ok, State}.

terminate(_Reason, _Req, #{username := Username}) ->
    case chat_redis:mark_offline(Username) of
        true ->
            chat_redis:publish(chat_config:chat_channel(),
                jsone:encode(#{type => offline, username => Username}));
        false ->
            ok
    end,
    ok;
terminate(_Reason, _Req, _State) ->
    ok.

error_json(Message) ->
    jsone:encode(#{error => Message}).
