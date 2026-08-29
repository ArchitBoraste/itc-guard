# MySQL 8 with the small-instance tuning baked in.
#
# small.cnf is COPIED rather than bind-mounted, and this is not a preference.
# MySQL REFUSES to read a world-writable option file, and it does so with a
# warning rather than an error:
#
#   mysqld: [Warning] World-writable config file '/etc/mysql/conf.d/small.cnf'
#           is ignored.
#
# The server then starts perfectly happily on stock defaults — performance_schema
# on, 128 MB buffer pool, binary logging on — which on a 1 GB box is ~360 MB RSS
# against a 384 MB cap, i.e. an OOM kill under the first real load, with nothing
# in the application logs to explain it. A bind mount hands MySQL whatever
# permissions the host filesystem chose (0777 from a Docker Desktop mount on
# Windows, 0644 from a normal git checkout on Linux), so whether the tuning
# applied would depend on which machine ran the deploy.
#
# Copying it and fixing the mode makes that platform-independent.

FROM mysql:8.0

COPY small.cnf /etc/mysql/conf.d/small.cnf
# Read-only for everyone, owned by root: exactly what MySQL requires before it
# will honour the file.
RUN chmod 0444 /etc/mysql/conf.d/small.cnf
