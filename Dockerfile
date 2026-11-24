FROM python:3.11-slim
WORKDIR /app
COPY . .
ENV PORT=3000
ENV GLOWOPS_DATA=/tmp/glowops-data
ENV PYTHONUNBUFFERED=1
EXPOSE 3000
CMD ["python", "live/server.py"]
