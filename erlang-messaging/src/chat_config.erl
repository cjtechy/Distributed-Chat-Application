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
    online_key/0
]).

load() ->
    application:set_env(chat_messaging, port, env_int("ERLANG_WS_PORT", port())),
    application:set_env(chat_messaging, secret_key, env_bin("SECRET_KEY", <<"change-me-in-production">>)),
    application:set_env(chat_messaging, redis_host, env_str("REDIS_HOST", "127.0.0.1")),
    application:set_env(chat_messaging, redis_port, env_int("REDIS_PORT", 6379)),
    application:set_env(chat_messaging, redis_db, env_int("REDIS_DB", 0)),
    application:set_env(chat_messaging, redis_password, env_str("REDIS_PASSWORD", "")),
    application:set_env(chat_messaging, chat_channel, env_bin("REDIS_CHAT_CHANNEL", <<"chat:messages">>)),
    application:set_env(chat_messaging, inbound_channel, env_bin("REDIS_INBOUND_CHANNEL", <<"chat:inbound">>)),
    application:set_env(chat_messaging, online_key, env_bin("REDIS_ONLINE_KEY", <<"chat:online_users">>)),
    ok.

port() -> env_cached(port, 8080).
secret_key() -> env_cached(secret_key, <<"change-me-in-production">>).
redis_host() -> env_cached(redis_host, "127.0.0.1").
redis_port() -> env_cached(redis_port, 6379).
redis_db() -> env_cached(redis_db, 0).
redis_password() -> env_cached(redis_password, "").
chat_channel() -> env_cached(chat_channel, <<"chat:messages">>).
inbound_channel() -> env_cached(inbound_channel, <<"chat:inbound">>).
online_key() -> env_cached(online_key, <<"chat:online_users">>).

env_cached(Key, Default) ->
    case application:get_env(chat_messaging, Key) of
        {ok, Value} -> Value;
        undefined -> Default
    end.

env_str(Name, Default) ->
    case os:getenv(Name) of
        false -> Default;
        "" -> Default;
        Value -> Value
    end.

env_bin(Name, Default) ->
    case env_str(Name, undefined) of
        undefined -> Default;
        Value -> list_to_binary(Value)
    end.

env_int(Name, Default) ->
    case env_str(Name, undefined) of
        undefined -> Default;
        Value -> list_to_integer(Value)
    end.
