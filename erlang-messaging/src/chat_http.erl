-module(chat_http).
-behaviour(gen_server).

-export([start_link/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

init([]) ->
    Port = chat_config:port(),
    Dispatch = cowboy_router:compile([
        {'_', [
            {"/health", chat_health, []},
            {"/v1/ws", chat_ws, []}
        ]}
    ]),
    {ok, _} = cowboy:start_clear(chat_http_listener, [{port, Port}], #{
        env => #{dispatch => Dispatch}
    }),
    {ok, #{port => Port}}.

handle_call(_Request, _From, State) ->
    {reply, ok, State}.

handle_cast(_Msg, State) ->
    {noreply, State}.

handle_info(_Info, State) ->
    {noreply, State}.

terminate(_Reason, _State) ->
    cowboy:stop_listener(chat_http_listener),
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.
