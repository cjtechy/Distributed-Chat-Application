-module(chat_hmac).

-export([wrap/1, unwrap/1]).

wrap(Payload) when is_binary(Payload) ->
    Sig = hex(crypto:mac(hmac, sha256, chat_config:secret_key(), Payload)),
    jsone:encode(#{<<"sig">> => Sig, <<"data">> => Payload}).

unwrap(Wrapped) when is_binary(Wrapped) ->
    try jsone:decode(Wrapped, [{object_format, map}]) of
        #{<<"sig">> := Sig, <<"data">> := Data} when is_binary(Sig), is_binary(Data) ->
            Expected = hex(crypto:mac(hmac, sha256, chat_config:secret_key(), Data)),
            case byte_size(Expected) =:= byte_size(Sig) andalso crypto:hash_equals(Expected, Sig) of
                true -> {ok, Data};
                false -> {error, bad_signature}
            end;
        _ ->
            {error, unsigned}
    catch
        _:_ -> {error, invalid}
    end;
unwrap(_) ->
    {error, invalid}.

hex(Bin) ->
    << <<(nibble(N))>> || <<N:4>> <= Bin >>.

nibble(N) when N < 10 -> $0 + N;
nibble(N) -> $a + (N - 10).
