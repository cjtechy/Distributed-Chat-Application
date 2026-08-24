FROM erlang:26

WORKDIR /opt/chat/erlang-messaging
RUN curl -fsSL -o /usr/local/bin/rebar3 https://github.com/erlang/rebar3/releases/latest/download/rebar3 \
    && chmod +x /usr/local/bin/rebar3
COPY erlang-messaging /opt/chat/erlang-messaging
RUN rebar3 compile

EXPOSE 8080
CMD ["sh", "-c", "export DOTENV_PATH=${DOTENV_PATH:-/etc/chat.env}; exec erl -noshell -noinput -pa _build/default/lib/*/ebin -eval 'application:ensure_all_started(chat_messaging).'"]
