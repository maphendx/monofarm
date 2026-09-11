FROM python:3.12-slim

WORKDIR /app

COPY requirements-core.txt .
RUN pip install --no-cache-dir -r requirements-core.txt

COPY monofarm_agent.py .
COPY source_manifest.py source_manifest.json ./
COPY core/ ./core/
COPY transports/ ./transports/
COPY printers/ ./printers/
COPY anycubic_local/ ./anycubic_local/

ENTRYPOINT ["python", "monofarm_agent.py"]
