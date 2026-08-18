-module(chat_sub).
-behaviour(gen_server).

-export([start_link/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

init([]) ->
    Host = chat_config:redis_host(),
    Port = chat_config:redis_port(),
    Password = chat_config:redis_password(),
    {ok, Sub} = eredis_sub:start_link(Host, Port, Password),
    ok = eredis_sub:controlling_process(Sub, self()),
    Channel = chat_config:chat_channel(),
    eredis_sub:subscribe(Sub, [Channel]),
    {ok, #{sub => Sub}}.

handle_call(_Request, _From, State) ->
    {reply, ok, State}.

handle_cast(_Msg, State) ->
    {noreply, State}.

handle_info({subscribed, _Channel, _Pid}, #{sub := Sub} = State) ->
    eredis_sub:ack_message(Sub),
    {noreply, State};
handle_info({message, _Channel, Payload, _Pid}, #{sub := Sub} = State) ->
    eredis_sub:ack_message(Sub),
    case chat_hmac:unwrap(Payload) of
        {ok, Inner} -> chat_clients:broadcast(Inner);
        {error, _} -> ok
    end,
    {noreply, State};
handle_info({eredis_disconnected, _Pid}, #{sub := Sub} = State) ->
    eredis_sub:ack_message(Sub),
    {noreply, State};
handle_info({eredis_connected, _Pid}, #{sub := Sub} = State) ->
    eredis_sub:ack_message(Sub),
    eredis_sub:subscribe(Sub, [chat_config:chat_channel()]),
    {noreply, State};
handle_info(_Info, #{sub := Sub} = State) ->
    eredis_sub:ack_message(Sub),
    {noreply, State}.

terminate(_Reason, _State) ->
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.
