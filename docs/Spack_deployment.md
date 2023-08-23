软件部署
====
## 1. Spack 相关
### 1.1. 介绍
Spack is a package manager for supercomputers, Linux, and macOS. It makes installing scientific software easy. Spack isn’t tied to a particular language; you can build a software stack in Python or R, link to libraries written in C, C++, or Fortran, and easily swap compilers or target specific microarchitectures.

### 1.2. 安装 Spack
```
git clone https://github.com/spack/spack
cd spack
git checkout releases/v0.18
git pull
. share/spack/setup-env.sh
# 测试安装完成
which spack
```

### 1.3. 启动 Shell 自动加载 Spack 环境
```bash
echo ". <Your spack path>/share/spack/setup-env.sh" >> ~/.bashrc
```

### 1.4. Spack Spec
| 项目 | 解释 | 示例 |
| -- | -- | -- |
| @ | 版本 | @8.6.10 |
| % | 编译器 | %gcc@9.2.1 |
| + or ~ | 布尔型选项开关 | ~optimize |
| name=\<value\> | 键值对型选项 | |
| name=<value> | 编译器选项 | cppflags=-O3 | 
| target=\<value\> | 系统架构选择符 | target=x86_64 |
| ^ | 依赖的 Spec | ^zlib@1.2.11 |
| / | 哈希值 | /e6wlrkfdmxvkipcafdjkz6w7b5q7g7vv |
**示例**
```bash
python@3.9.12%gcc+bz2+ctypes+dbm~debug+ensurepip+libxml2+lzma~nis~optimizations+pic+pyexpat+pythoncmd+readline+shared+sqlite3+ssl~tix~tkinter~ucs4+uuid+zlib/wctqfkpxekoo6g36gdqjuohit6ikh37z
```

### 1.5. 常用命令
1. `spack list`：列出全部可安装的包
1. `spack info <package name>`：显示指定包的详细信息
1. `spack install <package name>`：安装指定包
1. `spack uninstall <package name>`：删除指定包
1. `spack find <filter spec>`：使用指定 Spec 搜索安装的包
1. `spack load <package name>`：加载指定包
1. `spack unload <package name>`：卸载指定包

### 1.6. 命令输出解析
1. `spack install <package name>`：返回 Hash 直接解析
1. `spack find --json <filter spec>`：返回 JSON 直接解析
```json
[
  {
    "name": "ffmpeg",
    "version": "4.4.1",
    "arch": {
      "platform": "linux",
      "platform_os": "ubuntu22.04",
      "target": {
        "name": "zen2",
        "vendor": "AuthenticAMD",
        "features": [
          "abm",
          "aes",
          "avx",
          "avx2",
          "bmi1",
          "bmi2",
          "clflushopt",
          "clwb",
          "clzero",
          "cx16",
          "f16c",
          "fma",
          "fsgsbase",
          "mmx",
          "movbe",
          "pclmulqdq",
          "popcnt",
          "rdseed",
          "sse",
          "sse2",
          "sse4_1",
          "sse4_2",
          "sse4a",
          "ssse3",
          "xsavec",
          "xsaveopt"
        ],
        "generation": 0,
        "parents": [
          "zen"
        ]
      }
    },
    "compiler": {
      "name": "gcc",
      "version": "11.2.0"
    },
    "namespace": "builtin",
    "parameters": {
      "X": false,
      "avresample": false,
      "bzlib": true,
      "drawtext": false,
      "gpl": true,
      "libaom": false,
      "libmp3lame": false,
      "libopenjpeg": false,
      "libopus": false,
      "libsnappy": false,
      "libspeex": false,
      "libssh": false,
      "libvorbis": false,
      "libvpx": false,
      "libwebp": false,
      "libx264": false,
      "libzmq": false,
      "lzma": false,
      "nonfree": false,
      "openssl": false,
      "sdl2": false,
      "shared": true,
      "version3": true,
      "cflags": [],
      "cppflags": [],
      "cxxflags": [],
      "fflags": [],
      "ldflags": [],
      "ldlibs": []
    },
    "package_hash": "jbq7iibvfkrk4pwxw7dxxlcunvidnnme3ybcufun7n6e45apc3dq====",
    "dependencies": [
      {
        "name": "alsa-lib",
        "hash": "rtgu4t6t24kaml7tjfyouaxnhrfmbcuv",
        "type": [
          "build",
          "link"
        ]
      },
      {
        "name": "bzip2",
        "hash": "3ehdbvyrufsbvuphnv7irzqrsitjcf7x",
        "type": [
          "build",
          "link"
        ]
      },
      {
        "name": "libiconv",
        "hash": "g7r7mavt75f6ssuwxmqjtjfpcxtcnsfp",
        "type": [
          "build",
          "link"
        ]
      },
      {
        "name": "yasm",
        "hash": "464nc2qfuwhrehr3kq2dj3l66lczmxfp",
        "type": [
          "build",
          "link"
        ]
      },
      {
        "name": "zlib",
        "hash": "4yickfu5x4fsuhst6yabv3keqkupoq43",
        "type": [
          "build",
          "link"
        ]
      }
    ],
    "hash": "3imr3mw2wldo3utvdzamxkr6c4gnxhdg"
  }
]
```
1. `spack find -L -v -f -v <filter spec>`：返回 Spec 字符串，正则解析
`(?m)^(?P<hash>\w{32}) (?P<packageName>.+?)@(?P<version>.+?)%(?P<compiler>(?:gcc|clang|msvc))(?: (?P<flags>[~|+].+?))?(?: (?P<options>.+?))?$`

### 1.7. 有用的文档
1. [新墨西哥州州立大学计算中心 Spack 帮助](https://hpc.nmsu.edu/discovery/software/spack/)
1. [Spack 官方文档](https://spack.readthedocs.io/en/latest/)

## 2. slurm 相关
### 2.1. 介绍
Slurm is an open source, fault-tolerant, and highly scalable cluster management and job scheduling system for large and small Linux clusters.

### 2.2. 安装
1. [官方安装文档](https://slurm.schedmd.com/quickstart_admin.html)
1. [slurm 与 mpi 安装文档](https://www.cnblogs.com/aobaxu/p/16195237.html)

### 2.3. Slurm 输出解析
1. 
