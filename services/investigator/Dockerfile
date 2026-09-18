# Netra investigation task.
#
# One ephemeral container per investigation. On Fargate this container IS the
# isolation boundary: it cannot nest another container, so it is built to be
# the thing that is safe to point at an untrusted repository -- non-root, no
# build toolchain, no package manager at runtime, and only the read-only
# analysis tools the allowlist can name.
FROM python:3.12-slim-bookworm

# git and ripgrep are the analysis tools; openssl signs the GitHub App JWT.
# ca-certificates is needed to reach GitHub and the model gateway over TLS.
RUN apt-get update \
 && apt-get install --no-install-recommends -y \
      git=1:2.39.* \
      ripgrep \
      openssl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 netra \
 && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin netra

WORKDIR /app

# boto3 is the only runtime dependency, and only the AWS entrypoint uses it.
RUN pip install --no-cache-dir "boto3>=1.35,<2"

COPY netra_investigator/ /app/netra_investigator/

# git refuses to operate on a repository owned by another uid; the workspace is
# a copy this user created.
RUN git config --system --add safe.directory '*' \
 && chown -R 10001:10001 /app

USER 10001:10001
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/home/netra

ENTRYPOINT ["python", "-m", "netra_investigator.aws.task"]
