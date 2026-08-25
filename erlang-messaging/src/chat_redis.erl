-module(chat_redis).
-behaviour(gen_server).

-export([start_link/0, publish/2, mark_online/1, mark_online/2, mark_offline/1, mark_offline/2, online_users/0, is_member/2, consume_ticket/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

publish(Channel, Payload) when is_binary(Channel), is_binary(Payload) ->
    gen_server:cast(?MODULE, {publish, Channel, chat_hmac:wrap(Payload)}).

mark_online(Username) ->
    mark_online(Username, 1).

mark_online(Username, GroupId) ->
    gen_server:call(?MODULE, {mark_online, Username, GroupId}).

mark_offline(Username) ->
    mark_offline(Username, 1).

mark_offline(Username, GroupId) ->
    gen_server:call(?MODULE, {mark_offline, Username, GroupId}).

online_users() ->
    gen_server:call(?MODULE, {online_users, 1}).

is_member(GroupId, Username) ->
    gen_server:call(?MODULE, {is_member, GroupId, Username}).

consume_ticket(Ticket) when is_binary(Ticket), Ticket =/= <<>> ->
    gen_server:call(?MODULE, {consume_ticket, Ticket});
consume_ticket(_) ->
    {error, invalid}.

init([]) ->
    Host = chat_config:redis_host(),
    Port = chat_config:redis_port(),
    Db = chat_config:redis_db(),
    Password = chat_config:redis_password(),
    {ok, Conn} = eredis:start_link(Host, Port, Db, Password),
    {ok, #{conn => Conn}}.

handle_call({mark_online, Username, GroupId}, _From, #{conn := Conn} = State) ->
    {ok, CountBin} = eredis:q(Conn, ["HINCRBY", online_key(GroupId), Username, "1"]),
    Count = binary_to_integer(CountBin),
    {ok, PresBin} = eredis:q(Conn, ["HINCRBY", presence_key(), Username, "1"]),
    GlobalNew = binary_to_integer(PresBin) =:= 1,
    {ok, Users} = fetch_users(Conn, GroupId),
    {reply, {Users, Count =:= 1, GlobalNew}, State};
handle_call({mark_offline, Username, GroupId}, _From, #{conn := Conn} = State) ->
    {ok, CountBin} = eredis:q(Conn, ["HINCRBY", online_key(GroupId), Username, "-1"]),
    Count = binary_to_integer(CountBin),
    WentOffline = Count =< 0,
    case WentOffline of
        true -> eredis:q(Conn, ["HDEL", online_key(GroupId), Username]);
        false -> ok
    end,
    {ok, PresBin} = eredis:q(Conn, ["HINCRBY", presence_key(), Username, "-1"]),
    Pres = binary_to_integer(PresBin),
    GlobalOff = Pres =< 0,
    Ts = case GlobalOff of
        true ->
            eredis:q(Conn, ["HDEL", presence_key(), Username]),
            Time = integer_to_binary(erlang:system_time(second)),
            eredis:q(Conn, ["HSET", last_seen_key(), Username, Time]),
            Time;
        false ->
            <<>>
    end,
    {reply, {WentOffline, GlobalOff, Ts}, State};
handle_call({online_users, GroupId}, _From, #{conn := Conn} = State) ->
    {ok, Users} = fetch_users(Conn, GroupId),
    {reply, Users, State};
handle_call({is_member, GroupId, Username}, _From, #{conn := Conn} = State) ->
    case eredis:q(Conn, ["SISMEMBER", members_key(GroupId), Username]) of
        {ok, <<"1">>} -> {reply, true, State};
        {ok, 1} -> {reply, true, State};
        _ -> {reply, false, State}
    end;
handle_call({consume_ticket, Ticket}, _From, #{conn := Conn} = State) ->
    Key = <<"chat:ws_ticket:", Ticket/binary>>,
    case eredis:q(Conn, ["GET", Key]) of
        {ok, Username} when is_binary(Username), Username =/= <<>> ->
            eredis:q(Conn, ["DEL", Key]),
            {reply, {ok, Username}, State};
        _ ->
            {reply, {error, not_found}, State}
    end;
handle_call(_Request, _From, State) ->
    {reply, {error, unknown}, State}.

handle_cast({publish, Channel, Payload}, #{conn := Conn} = State) ->
    eredis:q(Conn, ["PUBLISH", Channel, Payload]),
    {noreply, State};
handle_cast(_Msg, State) ->
    {noreply, State}.

handle_info(_Info, State) ->
    {noreply, State}.

terminate(_Reason, _State) ->
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

online_key(GroupId) ->
    Key = chat_config:online_key(),
    Id = integer_to_binary(GroupId),
    <<Key/binary, ":", Id/binary>>.

presence_key() -> <<"chat:presence">>.

last_seen_key() -> <<"chat:last_seen">>.

members_key(GroupId) ->
    Id = integer_to_binary(GroupId),
    <<"chat:group:", Id/binary, ":members">>.

fetch_users(Conn, GroupId) ->
    case eredis:q(Conn, ["HKEYS", online_key(GroupId)]) of
        {ok, Keys} when is_list(Keys) ->
            {ok, lists:sort(Keys)};
        {ok, undefined} ->
            {ok, []};
        Error ->
            Error
    end.
