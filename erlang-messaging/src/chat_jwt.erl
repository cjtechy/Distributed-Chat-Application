-module(chat_jwt).

-export([verify/2]).

%% HS256 JWT verifier compatible with PyJWT (sub + exp).
verify(Token, Secret) when is_binary(Token), is_binary(Secret) ->
    case binary:split(Token, <<".">>, [global]) of
        [HeaderB64, PayloadB64, SigB64] ->
            SigningInput = <<HeaderB64/binary, ".", PayloadB64/binary>>,
            Expected = crypto:mac(hmac, sha256, Secret, SigningInput),
            case decode_sig(SigB64) of
                {ok, Given} when byte_size(Given) =:= byte_size(Expected) ->
                    case crypto:hash_equals(Expected, Given) of
                        true -> decode_claims(HeaderB64, PayloadB64);
                        false -> {error, bad_signature}
                    end;
                _ ->
                    {error, bad_signature}
            end;
        _ ->
            {error, malformed}
    end;
verify(_, _) ->
    {error, malformed}.

decode_sig(B64) ->
    try
        {ok, b64url_decode(B64)}
    catch
        _:_ -> {error, bad_signature}
    end.

decode_claims(HeaderB64, PayloadB64) ->
    try
        Header = jsone:decode(b64url_decode(HeaderB64), [{object_format, map}]),
        Payload = jsone:decode(b64url_decode(PayloadB64), [{object_format, map}]),
        Alg = maps:get(<<"alg">>, Header, undefined),
        Sub = maps:get(<<"sub">>, Payload, undefined),
        Exp = maps:get(<<"exp">>, Payload, 0),
        Now = erlang:system_time(second),
        case {Alg, Sub, is_integer(Exp) andalso Exp > Now} of
            {<<"HS256">>, Username, true} when is_binary(Username), Username =/= <<>> ->
                {ok, Username};
            _ ->
                {error, invalid_claims}
        end
    catch
        _:_ -> {error, invalid_claims}
    end.

b64url_decode(Bin) ->
    Pad = case byte_size(Bin) rem 4 of
        0 -> <<>>;
        2 -> <<"==">>;
        3 -> <<"=">>;
        1 -> <<"===">>
    end,
    Std = binary:replace(
        binary:replace(<<Bin/binary, Pad/binary>>, <<"-">>, <<"+">>, [global]),
        <<"_">>, <<"/">>, [global]),
    base64:decode(Std).
