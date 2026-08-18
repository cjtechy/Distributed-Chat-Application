-module(chat_config).

-export([
    load/0,
    port/0,
    secret_key/0,
    redis_host/0,
    redis_port/0,
    redis_db/0,
    redis_password/0,
    chat_channel/0,
    inbound_channel/0,
    online_key/0,
    max_group_users/0
]).

load() ->
    case chat_dotenv:load() of
        ok -> ok;
        {error, Reason} ->
            error({missing_dotenv, Reason})
    end,
    application:set_env(chat_messaging, port, required_int("ERLANG_WS_PORT")),
    application:set_env(chat_messaging, secret_key, required_bin("SECRET_KEY")),
    application:set_env(chat_messaging, redis_host, required_str("REDIS_HOST")),
    application:set_env(chat_messaging, redis_port, required_int("REDIS_PORT")),
    application:set_env(chat_messaging, redis_db, required_int("REDIS_DB")),
    application:set_env(chat_messaging, redis_password, optional_str("REDIS_PASSWORD", "")),
    application:set_env(chat_messaging, chat_channel, required_bin("REDIS_CHAT_CHANNEL")),
    application:set_env(chat_messaging, inbound_channel, required_bin("REDIS_INBOUND_CHANNEL")),
    application:set_env(chat_messaging, online_key, required_bin("REDIS_ONLINE_KEY")),
    application:set_env(chat_messaging, max_group_users, optional_int("MAX_GROUP_USERS", 1000)),
    ok.

port() -> env_cached(port).
secret_key() -> env_cached(secret_key).
redis_host() -> env_cached(redis_host).
redis_port() -> env_cached(redis_port).
redis_db() -> env_cached(redis_db).
redis_password() -> env_cached(redis_password).
chat_channel() -> env_cached(chat_channel).
inbound_channel() -> env_cached(inbound_channel).
online_key() -> env_cached(online_key).
max_group_users() -> env_cached(max_group_users).

env_cached(Key) ->
    case application:get_env(chat_messaging, Key) of
        {ok, Value} -> Value;
        undefined -> error({config_not_loaded, Key})
    end.

required_str(Key) ->
    case chat_dotenv:get(Key) of
        {ok, Value} when Value =/= "" -> Value;
        _ -> error({required_env, Key, "Set it in backend/.env"})
    end.

optional_str(Key, Default) ->
    case chat_dotenv:get(Key) of
        {ok, Value} -> Value;
        undefined -> Default
    end.

optional_int(Key, Default) ->
    case chat_dotenv:get(Key) of
        {ok, Value} when Value =/= "" ->
            case string:to_integer(Value) of
                {Int, ""} -> Int;
                _ -> error({invalid_integer, Key, Value})
            end;
        _ -> Default
    end.

required_bin(Key) ->
    list_to_binary(required_str(Key)).

required_int(Key) ->
    Value = required_str(Key),
    case string:to_integer(Value) of
        {Int, ""} -> Int;
        _ -> error({invalid_integer, Key, Value})
    end.
