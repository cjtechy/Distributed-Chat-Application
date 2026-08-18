-module(chat_dotenv).

-export([load/0, get/1]).

-define(TABLE, chat_dotenv).

%% Parse backend/.env (same file as FastAPI) into a named ETS table.
load() ->
    case find_file() of
        {ok, Path} ->
            Vars = parse_file(Path),
            Table =
                case ets:info(?TABLE) of
                    undefined -> ets:new(?TABLE, [named_table, protected, set]);
                    _ -> ?TABLE
                end,
            ets:delete_all_objects(Table),
            lists:foreach(
                fun({Key, Value}) -> ets:insert(Table, {Key, Value}) end,
                Vars
            ),
            error_logger:info_msg(
                "Loaded ~p environment variables from ~s~n",
                [length(Vars), Path]
            ),
            ok;
        {error, Reason} ->
            {error, Reason}
    end.

get(Key) when is_list(Key) ->
    case ets:lookup(?TABLE, Key) of
        [{Key, Value}] ->
            {ok, Value};
        [] ->
            case os:getenv(Key) of
                false -> undefined;
                "" -> undefined;
                ShellValue -> {ok, ShellValue}
            end
    end.

find_file() ->
    find_file(candidates()).

find_file([]) ->
    {error, {dotenv_not_found, candidates()}};
find_file([Path | Rest]) ->
    Normalized = normalize_path(Path),
    case filelib:is_file(Normalized) of
        true -> {ok, Normalized};
        false -> find_file(Rest)
    end.

normalize_path(Path) when is_list(Path) ->
    Clean =
        lists:flatten(
            string:replace(string:trim(Path), "\\", "/", all)
        ),
    filename:absname(Clean);
normalize_path(Path) when is_binary(Path) ->
    normalize_path(binary_to_list(Path)).

candidates() ->
    Explicit =
        case os:getenv("DOTENV_PATH") of
            false -> [];
            Path -> [normalize_path(Path)]
        end,
    Cwd = filename:absname("."),
    Root = filename:absname(filename:join(Cwd, "..")),
    Explicit ++ [
        filename:join([Root, "backend", ".env"]),
        filename:join([Cwd, "..", "backend", ".env"]),
        filename:join([Cwd, "backend", ".env"])
    ].

parse_file(Path) ->
    {ok, Bin} = file:read_file(Path),
    Lines = binary:split(Bin, <<"\n">>, [global]),
    lists:foldl(fun parse_line/2, [], Lines).

parse_line(Line, Acc) ->
    Trimmed = trim(trim_binary(Line)),
    case Trimmed of
        <<>> -> Acc;
        <<"#", _/binary>> -> Acc;
        _ ->
            case binary:match(Trimmed, <<"=">>) of
                {Pos, _} ->
                    KeyBin = binary:part(Trimmed, 0, Pos),
                    ValueBin = binary:part(Trimmed, Pos + 1, byte_size(Trimmed) - Pos - 1),
                    Key = trim_string(KeyBin),
                    Value = trim_string(ValueBin),
                    [{Key, Value} | Acc];
                nomatch ->
                    Acc
            end
    end.

trim_string(Bin) when is_binary(Bin) ->
    binary_to_list(trim(Bin));
trim_string(List) when is_list(List) ->
    binary_to_list(trim_binary(list_to_binary(List))).

trim_binary(Bin) when is_binary(Bin) ->
    trim_left(trim_right(Bin));
trim_binary(List) when is_list(List) ->
    trim_binary(list_to_binary(List)).

trim_left(<<>>) ->
    <<>>;
trim_left(<<C, Rest/binary>>) when C =:= 32; C =:= 9; C =:= 13; C =:= 10 ->
    trim_left(Rest);
trim_left(Bin) ->
    Bin.

trim_right(Bin) ->
    case byte_size(Bin) of
        0 ->
            Bin;
        Size ->
            case binary:at(Bin, Size - 1) of
                C when C =:= 32; C =:= 9; C =:= 13; C =:= 10 ->
                    trim_right(binary:part(Bin, 0, Size - 1));
                _ ->
                    Bin
            end
    end.

trim(<<>>) ->
    <<>>;
trim(Bin) ->
    case binary:split(Bin, <<"#">>) of
        [NoComment | _] ->
            Stripped = trim_binary(NoComment),
            case byte_size(Stripped) >= 2 of
                true ->
                    <<Quote, Rest/binary>> = Stripped,
                    case Quote of
                        34 ->
                            unquote(Rest, 34);
                        39 ->
                            unquote(Rest, 39);
                        _ ->
                            Stripped
                    end;
                false ->
                    Stripped
            end
    end.

unquote(Bin, Quote) when is_integer(Quote) ->
    case binary:split(Bin, <<Quote>>) of
        [Value, _] -> trim_binary(Value);
        _ -> trim_binary(Bin)
    end.
