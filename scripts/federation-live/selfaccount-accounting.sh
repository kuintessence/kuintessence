#!/bin/bash
set -euo pipefail
[[ ${KQ_SLURM_AGENT:-} == 1 && $$ != 1 ]]
mkdir -p /run/mysqld
chown mysql:mysql /run/mysqld
mysqld --user=mysql --skip-networking --innodb-buffer-pool-size=64M --innodb-log-file-size=32M >/tmp/mysql.log 2>&1 &
for _ in {1..60}; do mysqladmin ping --silent >/dev/null 2>&1 && break; sleep 1; done
mysqladmin ping --silent >/dev/null
password=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
mysql <<SQL
CREATE DATABASE slurm_acct_db;
CREATE USER 'slurm'@'localhost' IDENTIFIED BY '${password}';
GRANT ALL ON slurm_acct_db.* TO 'slurm'@'localhost';
SQL
cat >/etc/slurm/slurmdbd.conf <<EOF
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
chmod 600 /etc/slurm/slurmdbd.conf
chown slurm:slurm /etc/slurm/slurmdbd.conf
unset password
sed -i 's@AccountingStorageType=accounting_storage/none@AccountingStorageType=accounting_storage/slurmdbd\nAccountingStorageHost=localhost\nAccountingStoragePort=6819\nAccountingStoreFlags=job_comment\nJobAcctGatherFrequency=1@' /etc/slurm/slurm.conf
slurmdbd -D >/tmp/slurmdbd.log 2>&1 &
for _ in {1..30}; do sacctmgr -n list cluster >/dev/null 2>&1 && break; sleep 1; done
sacctmgr -i add cluster kq-cgroup-lab
sacctmgr -i add account lab Cluster=kq-cgroup-lab
sacctmgr -i add user scientist Account=lab
