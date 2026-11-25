FROM python:3.11-slim
WORKDIR /app
COPY . .
ENV PORT=3000
# Mount a Railway volume here so join keys / fleet SQLite survive restarts.
ENV GLOWOPS_DATA=/data
ENV PYTHONUNBUFFERED=1
EXPOSE 3000
CMD ["python", "live/server.py"]
