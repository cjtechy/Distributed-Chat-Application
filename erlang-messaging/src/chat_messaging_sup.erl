-module(chat_messaging_sup).
-behaviour(supervisor).

-export([start_link/0, init/1]).

start_link() ->
    supervisor:start_link({local, ?MODULE}, ?MODULE, []).

init([]) ->
    Children = [
        #{id => chat_clients,
          start => {chat_clients, start_link, []},
          restart => permanent,
          shutdown => 5000,
          type => worker,
          modules => [chat_clients]},
        #{id => chat_redis,
          start => {chat_redis, start_link, []},
          restart => permanent,
          shutdown => 5000,
          type => worker,
          modules => [chat_redis]},
        #{id => chat_sub,
          start => {chat_sub, start_link, []},
          restart => permanent,
          shutdown => 5000,
          type => worker,
          modules => [chat_sub]},
        #{id => chat_http,
          start => {chat_http, start_link, []},
          restart => permanent,
          shutdown => 5000,
          type => worker,
          modules => [chat_http]}
    ],
    {ok, {#{strategy => one_for_one, intensity => 10, period => 5}, Children}}.
