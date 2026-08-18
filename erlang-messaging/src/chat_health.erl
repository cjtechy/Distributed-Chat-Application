-module(chat_health).

-export([init/2]).

init(Req, State) ->
    Body = jsone:encode(#{
        status => ok,
        service => <<"chat_messaging">>,
        websocket_clients => chat_clients:count()
    }),
    Req2 = cowboy_req:reply(200, #{
        <<"content-type">> => <<"application/json">>
    }, Body, Req),
    {ok, Req2, State}.
