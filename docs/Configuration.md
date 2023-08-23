配置文档
=====
配置 Cos 的方式有两种，一种是使用配置文件，另一种是使用环境变量。配置文件使用 yaml 格式编写，在程序工作目录默认读取一个 config.yaml 文件作为基本的配置文件，或者从命令行中读取一个或多个相对路径作为配置文件。读取先后顺序为系统内置默认 -> config.yaml -> 命令行指定文件 -> 环境变量。环境变量前需要前缀为 cos。

## 1. 遥测配置
| 名称 | yaml 路径 | 环境变量 | 默认值 | 备注 |
|:--|:--|:--|:--|:--|
| 启用遥测系统 | `telemetry.enable` | `cos__telemetry__enable` | true | |
| 全局过滤级别 | `telemetry.max_level` | `cos__telemetry__max_level` | Trace | 过滤级别分为 Off、Trace、Debug、Info、Warn、Error 越靠右越大 |
| 全局自定义过滤规则 | `telemetry.level_fliter` | `cos__telemetry__level_fliter` | (空字符串) | 格式 `target[span{field=value}]=level` |
| 全局自定义过滤规则环境变量 | `telemetry.level_fliter_env` | `cos__telemetry__level_fliter_env` | "RUST_LOG" | 去指定环境变量去读取自定义过滤规则 |
| 启用控制台输出 | `telemetry.console.enable` | `cos__telemetry__console__enable` | true | |
| 启用调试输出 | `telemetry.console.enable_debug_logging` | `cos__telemetry__console__enable_debug_logging` | false | 可显示具体行号、文件 |
| 过滤级别 | `telemetry.console.max_level` | `cos__telemetry__console__max_level` | Trace | 过滤级别分为 Off、Trace、Debug、Info、Warn、Error 越靠右越大 |
| 自定义过滤规则 | `telemetry.console.level_fliter` | `cos__telemetry__console__level_fliter` | (空字符串) | 格式 `target[span{field=value}]=level` |
| 自定义过滤规则环境变量 | `telemetry.console.level_fliter_env` | `cos__telemetry__console__level_fliter_env` | "RUST_LOG" | 去指定环境变量去读取自定义过滤规则 |
| 启用文件输出 | `telemetry.file.enable` | `cos__telemetry__file__enable` | false | |
| 启用调试输出 | `telemetry.file.enable_debug_logging` | `cos__telemetry__file__enable_debug_logging` | false | 可显示具体行号、文件 |
| 过滤级别 | `telemetry.file.max_level` | `cos__telemetry__file__max_level` | Trace | 过滤级别分为 Off、Trace、Debug、Info、Warn、Error 越靠右越大 |
| 自定义过滤规则 | `telemetry.file.level_fliter` | `cos__telemetry__file__level_fliter` | (空字符串) | 格式 `target[span{field=value}]=level` |
| 自定义过滤规则环境变量 | `telemetry.file.level_fliter_env` | `cos__telemetry__file__level_fliter_env` | "RUST_LOG" | 去指定环境变量去读取自定义过滤规则 |
| 启用调用追踪 | `telemetry.remote.enable` | `cos__telemetry__remote__enable` | false | |
| 远程收集器地址 | `telemetry.remote.collector_endpoint` | `cos__telemetry__remote__collector_endpoint` | (空字符串) | |

## 2. 数据库配置
| 名称 | yaml 路径 | 环境变量 | 默认值 | 备注 |
|:--|:--|:--|:--|:--|
| 数据库地址 | `db.url` | `cos__db__url` | (空字符串) | |

## 3. Web 服务配置
| 名称 | yaml 路径 | 环境变量 | 默认值 | 备注 |
|:--|:--|:--|:--|:--|
| ip 或域名 | `host.bind_address` | `cos__host__bind_address` | "0.0.0.0" | |
| 端口 | `host.bind_port` | `cos__host__bind_port` | 80 | |

## 4. 消息队列配置
| 名称 | yaml 路径 | 环境变量 | 默认值 | 备注 |
|:--|:--|:--|:--|:--|
| 消息队列配置 | `mq.client_options` | `cos__client_options` | (空键值对组) | yaml 内格式：与普通对象一致，环境变量内格式，环境变量例子：cos.client_options.BOOTSTRAP.SERVERS |
| 消息队列 Topic | `mq.topics` | `cos__mq__topics` | (空数组) | |

## 5. 数据库配置
| 名称 | yaml 路径 | 环境变量 | 默认值 | 备注 |
|:--|:--|:--|:--|:--|
| 数据库地址 | `redis.url` | `cos__redis__url` | (空字符串) | |

## 6. 示例 yaml
```yaml
# 遥测配置
telemetry:
  # 启用遥测系统
  enable: true
  # 全局过滤级别
  # 过滤级别分为 Off、Trace、Debug、Info、Warn、Error 越靠右越大
  max_level: Trace
  # 全局自定义过滤规则
  # 格式 target[span{field=value}]=level
  level_fliter: ""
  # 全局自定义过滤规则环境变量
  # 去指定环境变量去读取自定义过滤规则
  level_fliter_env: "RUST_LOG"
  # 控制台输出配置
  console:
    # 启用控制台输出
    enable: true
    # 启用调试输出
    enable_debug_logging: false
    # 过滤级别
    # 过滤级别分为 Off、Trace、Debug、Info、Warn、Error 越靠右越大
    max_level: Trace
    # 自定义过滤规则
    # 格式 target[span{field=value}]=level
    level_fliter: ""
    # 自定义过滤规则环境变量
    # 去指定环境变量去读取自定义过滤规则
    level_fliter_env: "RUST_LOG"
  # 文件输出配置
  file:
    # 启用文件输出
    enable: false
    # 启用调试输出（带有文件、行号等）
    enable_debug_logging: false
    # 过滤级别
    # 过滤级别分为 Off、Trace、Debug、Info、Warn、Error 越靠右越大
    max_level: Trace
    # 自定义过滤规则
    # 格式 target[span{field=value}]=level
    level_fliter: ""
    # 自定义过滤规则环境变量
    # 去指定环境变量去读取自定义过滤规则
    level_fliter_env: "RUST_LOG"
    # 自定义日志文件夹位置
    path: "./logs"
    # 自定义日志文件名，或滚动写入前缀
    prefix: "prefix.log"
    # 滚动创建文件写入时长
    # 滚动时长分为 Daily（每日）、Hourly（每小时）、Minutely（每分钟）、Never（永不），
    rolling_time: Never
  # 远程调用追踪
  remote:
    # 启用调用追踪
    enable: false
    # 远程收集器地址
    collector_endpoint: ""
# 数据库
db:
  # 数据库地址
  url: ""
# Web 服务
host:
  # ip 或域名
  bind_address: ""
  # 端口
  bind_port: ""
# 消息队列
mq:
  # 消息队列 Topic
  topics:
  # 消息队列配置
  client_options:
# Redis 配置
redis:
  # Redis 地址
  url: "localhost:6379"
```
