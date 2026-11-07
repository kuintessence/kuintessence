#!/usr/bin/env bash
set -euo pipefail
[[ "${KQ_ACCOUNTING_LAB:-}" == 1 ]] || { echo "Isolated accounting lab only" >&2; exit 1; }
mkdir -p /run/mysqld /run/munge /var/log/munge /var/spool/slurmctld /var/spool/slurmd /var/log/slurm /scratch
chmod 1777 /scratch
chown mysql:mysql /run/mysqld
chown munge:munge /run/munge /var/log/munge
chown -R slurm:slurm /var/spool/slurmctld /var/spool/slurmd /var/log/slurm
if [[ ! -f /etc/munge/munge.key ]]; then
 head -c 1024 /dev/urandom >/etc/munge/munge.key
 chown munge:munge /etc/munge/munge.key
 chmod 0400 /etc/munge/munge.key
fi
munged --force
mysqld --user=mysql --skip-networking --innodb-buffer-pool-size=64M --innodb-log-file-size=32M >/tmp/mysql.log 2>&1 &
for _ in {1..60}; do mysqladmin ping --silent >/dev/null 2>&1 && break; sleep 1; done
mysqladmin ping --silent >/dev/null
password=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
mysql <<SQL
CREATE DATABASE IF NOT EXISTS slurm_acct_db;
CREATE USER IF NOT EXISTS 'slurm'@'localhost' IDENTIFIED BY '${password}';
GRANT ALL ON slurm_acct_db.* TO 'slurm'@'localhost';
SQL
cat >/etc/slurm-llnl/slurmdbd.conf <<EOF
AuthType=auth/munge
DbdHost=localhost
DbdPort=6819
SlurmUser=slurm
LogFile=/var/log/slurm/slurmdbd.log
PidFile=/run/slurmdbd.pid
StorageType=accounting_storage/mysql
StorageHost=localhost
StorageUser=slurm
StoragePass=${password}
StorageLoc=slurm_acct_db
EOF
chmod 0600 /etc/slurm-llnl/slurmdbd.conf
chown slurm:slurm /etc/slurm-llnl/slurmdbd.conf
unset password
sed -e "s/__HOSTNAME__/$(hostname -s)/g" -e "s/__CPUS__/$(nproc)/g" -e 's/__REAL_MEMORY__/768/g' -e 's@AccountingStorageType=accounting_storage/none@AccountingStorageType=accounting_storage/slurmdbd\nAccountingStorageHost=localhost\nAccountingStoragePort=6819\nAccountingStoreJobComment=YES@' -e 's@JobAcctGatherType=jobacct_gather/none@JobAcctGatherType=jobacct_gather/linux\nJobAcctGatherFrequency=1@' /etc/slurm-llnl/slurm.conf.template >/etc/slurm-llnl/slurm.conf
slurmdbd -D >/tmp/slurmdbd.log 2>&1 &
for _ in {1..30}; do sacctmgr -n list cluster >/dev/null 2>&1 && break; sleep 1; done
sacctmgr -i add cluster kq-docker-slurm >/tmp/cluster.log 2>&1
slurmctld -D >/tmp/slurmctld.log 2>&1 &
slurmd -D >/tmp/slurmd.log 2>&1 &
for _ in {1..30}; do sinfo -h -o '%T' 2>/dev/null | grep -Eq 'idle|alloc|mix' && break; sleep 1; done
sinfo -h -o '%T' | grep -Eq 'idle|alloc|mix'
echo 'Slurm accounting ready'
