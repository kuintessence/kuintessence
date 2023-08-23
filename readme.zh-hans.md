<p align="center">
  <a href="https://github.com/nsccjn/kuintessence"><img src="https://drawing-bed.dev.supercomputing.link/i/2023/08/23/nk4amf.png" alt="坤仪万象" /></a>
</p>

<h3 align="center">开源 HPC 计算编排系统</h3>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0.html"><img src="https://img.shields.io/badge/licenses-AGPLv3-orange" alt="License: AGPLv3"></a>
  <a href="https://img.shields.io/badge/release-v0.0.1-blue"><img src="https://img.shields.io/badge/release-v0.0.1-blue" alt=" release"></a>
</p>

---

[ [English](readme.md) | [简体中文](readme.zh-hans.md) ]

## 介绍

坤仪万象（Kuintessence）是先进的计算编排系统，旨在彻底改变 HPC 工作负载和集群管理。其主要目标是释放 HPC 用户更多注意力，使他们能够专注于科学研究，而不是被 HPC 环境的问题所困扰。通过这样的方式，Kuintessence 可以提高科研产出速度。

## 特性

- **自动化任务调度**：依据资源和优先级智能调度任务。
- **用户友好的界面**：轻松提交、监视和管理任务。
- **优化资源利用**：确保 HPC 资源的最大化使用。
- **安全性**：提供用户验证和权限管理，确保集群的安全。
- **可扩展性**：支持多种集群管理软件，如 SLURM、PBS、SGE 等。
- **接入简单**：无需修改集群配置，只需简单配置即可接入。

## 快速开始

1. 克隆此仓库

```bash
git clone https://github.com/nsccjn/kuintessence.git
```

2. 打开 docker 目录

```
docker-compose up -d
```

3. 打开浏览器，访问 http://localhost:8080

## 文档

[kuintessence 文档](https://docs.kuintessence.com)

## 贡献

我们欢迎社区的任何贡献！请参考我们的 [贡献指南](contributing.md) 以了解如何开始。

## 许可证

此项目使用 [GNU Affero General Public License](LICENSE) 许可证。
