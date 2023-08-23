<p align="center">
  <a href="https://github.com/nsccjn/kuintessence"><img src="https://drawing-bed.dev.supercomputing.link/i/2023/08/23/nk4a6n.png" alt="kuintessence" /></a>
</p>

<h3 align="center">Open Source HPC Computing System</h3>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0.html"><img src="https://img.shields.io/badge/licenses-agpl3.0-orange" alt="License: AGPLv3"></a>
  <a href="https://img.shields.io/badge/release-v0.0.1-blue"><img src="https://img.shields.io/badge/release-v0.0.1-blue" alt=" release"></a>
</p>

---

[ [English](readme.md) | [简体中文](readme.zh-hans.md) ]

## Introduction

Kuintessence is an advanced computing orchestration system designed to revolutionize HPC workload and cluster management. Its primary goal is to empower HPC users by allowing them to concentrate on their scientific ideas rather than getting bogged down by HPC environment complications. By doing so, Kuintessence enhances research productivity to its fullest potential.

## Features

- **Automated task scheduling**: schedule tasks intelligently based on resources and priorities.
- **User-friendly interface**: easily submit, monitor and manage tasks.
- **Optimized resource utilization**: ensure the maximum utilization of HPC resources.
- **Security**: provide user authentication and permission management to ensure the security of the cluster.
- **Scalability**: support a variety of cluster management software, such as SLURM, PBS, SGE, etc.
- **Easy to access**: no need to modify the cluster configuration, just configure it simply to access.

## Quick Start

1. Clone this repository

```bash
git clone https://github.com/nsccjn/kuintessence.git
```

2. Open the docker directory

```
docker-compose up -d
```

3. Open your browser and visit http://localhost:8080

## Documentation

[kuintessence docs](https://docs.kuintessence.com)

## Contributing

We welcome any contributions from the community! Please refer to our [contributing guide](contributing.md) to learn how to get started.

## License

This project is licensed under the [GNU Affero General Public License](LICENSE).
