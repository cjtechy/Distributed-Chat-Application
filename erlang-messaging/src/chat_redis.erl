-module(chat_redis).
-behaviour(gen_server).

-export([start_link/0, publish/2, mark_online/1, mark_offline/1, online_users/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

publish(Channel, Payload) when is_binary(Channel), is_binary(Payload) ->
    gen_server:cast(?MODULE, {publish, Channel, Payload}).

mark_online(Username) ->
    gen_server:call(?MODULE, {mark_online, Username}).

mark_offline(Username) ->
    gen_server:call(?MODULE, {mark_offline, Username}).

online_users() ->
    gen_server:call(?MODULE, online_users).

init([]) ->
    Host = chat_config:redis_host(),
    Port = chat_config:redis_port(),
    Db = chat_config:redis_db(),
    Password = chat_config:redis_password(),
    {ok, Conn} = eredis:start_link(Host, Port, Db, Password),
    {ok, #{conn => Conn}}.

handle_call({mark_online, Username}, _From, #{conn := Conn} = State) ->
    {ok, CountBin} = eredis:q(Conn, ["HINCRBY", chat_config:online_key(), Username, "1"]),
    Count = binary_to_integer(CountBin),
    {ok, Users} = fetch_users(Conn),
    {reply, {Users, Count =:= 1}, State};
handle_call({mark_offline, Username}, _From, #{conn := Conn} = State) ->
    {ok, CountBin} = eredis:q(Conn, ["HINCRBY", chat_config:online_key(), Username, "-1"]),
    Count = binary_to_integer(CountBin),
    WentOffline = Count =< 0,
    case WentOffline of
        true -> eredis:q(Conn, ["HDEL", chat_config:online_key(), Username]);
        false -> ok
    end,
    {reply, WentOffline, State};
handle_call(online_users, _From, #{conn := Conn} = State) ->
    {ok, Users} = fetch_users(Conn),
    {reply, Users, State};
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

fetch_users(Conn) ->
    case eredis:q(Conn, ["HKEYS", chat_config:online_key()]) of
        {ok, Keys} when is_list(Keys) ->
            {ok, lists:sort(Keys)};
        {ok, undefined} ->
            {ok, []};
        Error ->
            Error
    end.
