-module(chat_clients).
-behaviour(gen_server).

-export([start_link/0, join/2, count/0, broadcast/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(TAB, ?MODULE).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

join(Pid, Username) ->
    gen_server:call(?MODULE, {join, Pid, Username}).

count() ->
    ets:info(?TAB, size).

broadcast(Payload) when is_binary(Payload) ->
    ets:foldl(fun({Pid, _Username}, Acc) ->
        Pid ! {chat, Payload},
        Acc
    end, ok, ?TAB),
    ok.

init([]) ->
    Tab = ets:new(?TAB, [named_table, public, set, {read_concurrency, true}]),
    {ok, #{tab => Tab}}.

handle_call({join, Pid, Username}, _From, State) ->
    erlang:monitor(process, Pid),
    ets:insert(?TAB, {Pid, Username}),
    {reply, ok, State};
handle_call(_Request, _From, State) ->
    {reply, ok, State}.

handle_cast(_Msg, State) ->
    {noreply, State}.

handle_info({'DOWN', _Ref, process, Pid, _Reason}, State) ->
    ets:delete(?TAB, Pid),
    {noreply, State};
handle_info(_Info, State) ->
    {noreply, State}.

terminate(_Reason, _State) ->
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.
