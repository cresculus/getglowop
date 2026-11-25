FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt
ENV PORT=3000
# Persist inventory + partner renames on a Railway volume mounted at /data.
# /tmp is wiped on every deploy — never use it for GLOWOPS_DATA in production.
ENV GLOWOPS_DATA=/data
ENV PYTHONUNBUFFERED=1
EXPOSE 3000
CMD ["python", "live/server.py"]
