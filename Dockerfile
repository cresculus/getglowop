FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -r requirements.txt
ENV PORT=3000
# Customer data is in Supabase (DATABASE_URL). Do not mount a Railway volume for it.
ENV PYTHONUNBUFFERED=1
EXPOSE 3000
CMD ["python", "live/server.py"]
