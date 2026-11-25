FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt
ENV PORT=3000
# Prefer a Railway volume at /data in prod; /tmp keeps boot working without one.
ENV GLOWOPS_DATA=/tmp/glowops-data
ENV PYTHONUNBUFFERED=1
EXPOSE 3000
CMD ["python", "live/server.py"]
