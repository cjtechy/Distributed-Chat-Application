-module(chat_clients).
-behaviour(gen_server).

-export([start_link/0, join/2, join/3, count/0, broadcast/1, broadcast/2]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(TAB, ?MODULE).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

join(Pid, Username) ->
    join(Pid, Username, 1).

join(Pid, Username, GroupId) ->
    gen_server:call(?MODULE, {join, Pid, Username, GroupId}).

count() ->
    ets:info(?TAB, size).

broadcast(Payload) when is_binary(Payload) ->
    broadcast(group_id_from(Payload), Payload).

broadcast(GroupId, Payload) when is_integer(GroupId), is_binary(Payload) ->
    ets:foldl(fun
        ({Pid, _Username, Gid}, Acc) when Gid =:= GroupId ->
            Pid ! {chat, Payload},
            Acc;
        (_, Acc) ->
            Acc
    end, ok, ?TAB),
    ok.

init([]) ->
    Tab = ets:new(?TAB, [named_table, public, set, {read_concurrency, true}]),
    {ok, #{tab => Tab}}.

handle_call({join, Pid, Username, GroupId}, _From, State) ->
    Max = chat_config:max_group_users(),
    Current = ets:select_count(?TAB, [{{'_', '_', GroupId}, [], [true]}]),
    case Current >= Max of
        true ->
            {reply, {error, group_full}, State};
        false ->
            erlang:monitor(process, Pid),
            ets:insert(?TAB, {Pid, Username, GroupId}),
            {reply, ok, State}
    end;
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

group_id_from(Payload) ->
    try jsone:decode(Payload, [{object_format, map}]) of
        Map ->
            Value = maps:get(<<"group_id">>, Map, maps:get(group_id, Map, 1)),
            case Value of
                Id when is_integer(Id), Id > 0 -> Id;
                Id when is_binary(Id) ->
                    try binary_to_integer(Id) of
                        N when N > 0 -> N;
                        _ -> 1
                    catch
                        _:_ -> 1
                    end;
                _ -> 1
            end
    catch
        _:_ -> 1
    end.
