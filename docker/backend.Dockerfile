FROM python:3.11-slim

WORKDIR /opt/chat/backend
COPY backend/requirements.txt /opt/chat/backend/requirements.txt
RUN pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt
COPY backend /opt/chat/backend

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
