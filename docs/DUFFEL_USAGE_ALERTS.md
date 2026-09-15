# Duffel usage alerts

Production sends an email through the existing Brevo configuration when outbound Duffel attempts reach either 100 in a UTC hour or 1,000 in a UTC day. Redis counters make the thresholds shared across instances when Redis is available; a process-local fallback keeps alerting non-blocking if Redis is temporarily unavailable.

Alerts are emitted from the central outbound-attempt boundary, so retries count as separate physical attempts. Alert delivery never blocks or fails the Duffel request.
