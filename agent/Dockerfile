FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir websockets httpx

COPY monofarm_agent.py .

ENTRYPOINT ["python", "monofarm_agent.py"]
