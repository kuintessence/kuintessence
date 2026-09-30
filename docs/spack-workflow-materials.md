# 科学工作流 Spack 材料准备

## 适用范围与状态

本文用于盘点 15 个科学工作流的候选材料，并说明运维如何获取、校验、搬运及导入
recipe 与目标 Linux 材料。候选包名不是固定 recipe 的求解结果，不承诺对应版本、
variant 或软件组合可用。**15 个工作流均未完成材料、安装及科学运行验收。**

首个实现路线为工作流 10 中的 samtools 单软件垂直切片，不是完整变异检测流程。
该案例提供可重复的 GitHub Actions 验收入口；concretize、完整源码闭包、受管安装
和 Slurm 运行须分别核对对应提交的执行结果，不能将代码存在视为通过。
既有 GNU Hello 的通过记录不能用作 samtools 的验收证据。

当前没有面向这 15 个工作流的通用材料自动生成器，也没有可直接下载的完整材料
artifact。固定 Hello/samtools 新增[手动材料导出](spack-material-artifacts.md)入口，
默认只验证；完成审核并明确上传后，才会产生该次 run 的可下载材料。
不提供任意 spec 的通用导出入口，也不代表已生成 15 项材料。

运维可使用[材料交付与目标验收工作表](spack-workflow-acceptance.md)逐项记录
target/profile、recipe、lock/source、导入 binding 和科学运行证据。其候选 YAML
与空白记录不是平台导入 manifest，所有条目默认未验收。

## 材料分类

| 类别 | 必备内容 | 边界 |
|---|---|---|
| Recipe Git bundle | 完整固定 tree、`repo.yaml`、recipes、patch、辅助模块、许可文件及 `HEAD` | 自包含 SHA-1 Git bundle；recipe 是可执行代码，摘要不代替信任审核 |
| Linux lock/source 材料包 | 原生单 root `spack.lock`、完整源码 mirror、发布 manifest | 固定 Spack、目标架构、recipe commit/roots；源码不进入 recipe Git |
| 科学输入 | 合成输入，或独立取得的数据、赝势、力场、模型、基组和算例 | 单独记录版本、来源、SHA-256、大小、许可和使用范围；不因软件许可自动获得授权 |
| 运行环境 | 编译器及 external、Apptainer/SIF、site profile、调度器、存储和 quota | 不属于源码 mirror；目标计算节点必须另行确认兼容性 |

发布者须逐项自审软件、传递依赖、patch、示例与数据的使用和再分发条款，保留
版权声明及许可要求。`redistribution: "unrestricted"` 是发布者声明，不是平台的
自动许可鉴定；无法作出该声明的材料不得混入此发布路线。受限输入由使用者依法
取得，不进入公开 Git、artifact 或日志。

## 15 个工作流候选盘点

下表仅列候选包名，不给尚未 concretize 的组合指定“已可用”版本或 variant。
各项均需为实际 Linux target 单独求解；samtools 参考环境也不能推广为其他行的
适配承诺。许可栏是待完成的自审事项，不是法律结论或授权证明。

| ID / 工作流 | 候选 Spack 包 | 外部数据或输入 | 许可自审重点 | Target / MPI 与接口风险 | 状态 |
|---|---|---|---|---|---|
| 01 风道 CFD | `gmsh`、`openfoam`、`paraview`、`python` | 合成风道几何、边界条件和网格 | 软件依赖、教程及网格授权 | Linux；OpenFOAM 发行版及配置差异；MPI provider/ABI；ParaView 无头渲染与 Python 接口 | 未验收 |
| 02 悬臂梁结构 | `gmsh`、`calculix`、`py-meshio`、`paraview`、`python` | 合成悬臂梁、载荷与材料参数 | 软件、示例和转换代码许可 | Linux；OpenMP、Python/VTK ABI；mm–N–MPa 单位、物理组、FRD→VTU 支持 | 未验收 |
| 03 生物分子最小化 | `gromacs`、`gnuplot`、`python` | 外部 RCSB 1AKI 结构、力场和水模型 | 结构数据使用条款与力场许可分别核对 | Linux SIMD；MPI+OpenMP 组合；拓扑与坐标原子数一致性 | 未验收 |
| 04 原子分子动力学 | `py-ase`、`lammps`、`paraview`、`python` | 合成氩晶体和 Lennard-Jones 参数；外部势文件另行取得 | 软件及任何外部势文件许可 | Linux；MPI、LAMMPS 功能包与单位制；dump→VTK 字段契约 | 未验收 |
| 05 固体电子结构 | `quantum-espresso`、`wannier90`、`gnuplot`、`python` | Si 结构、外部 UPF 赝势 | 每个赝势的来源、版本及再分发条款 | Linux；MPI、BLAS/Fortran ABI；QE/Wannier 接口及 k 点数量、顺序 | 未验收 |
| 06 分子结构优化 | `cp2k`、`py-ase`、`gnuplot`、`python` | 合成水分子、匹配版本的 `BASIS_MOLOPT` / `GTH_POTENTIALS` | 基组、势文件与软件许可分别核对 | Linux；MPI+OpenMP、Fortran/BLAS；固定数据路径及元素条目 | 未验收 |
| 07 区域天气模拟 | `wps`、`wrf`、`cdo`、`py-xarray`、`py-netcdf4`、`python` | WPS 地理数据、NOAA GFS GRIB2 | 数据产品、时间范围、地理数据条款与再分发条件 | Linux；MPI、Fortran、HDF5/NetCDF；大文件预算与实际垂直层数；不预设 variant 可用 | 未验收 |
| 08 全球地震波 | `specfem3d-globe`、`py-obspy`、`python` | 固定版本的官方小型 benchmark、模型、震源和台站 | 模型、算例和观测数据授权 | Linux；MPI rank 与 `NCHUNKS/NPROC_XI/NPROC_ETA` 一致；网格内存与 Python 接口 | 未验收 |
| 09 AMR 天体物理 | `enzo`、`py-yt`、`hdf5`、`gnuplot`、`python` | 固定 release/commit 的 `ShockPool3D` 输入，不使用浮动分支 | 官方样例与软件许可 | Linux；MPI/HDF5/yt 版本兼容、层次输出和单位转换 | 未验收 |
| 10 变异检测 | `fastp`、`bwa-mem2`、`samtools`、`bcftools`、`python` | 合成参考序列、read pairs 和 truth；首个切片仅合成 SAM | 软件及依赖许可；真实基因组数据另行治理 | Linux CPU SIMD、线程总预算、BAM/VCF/索引契约；不假定需要 MPI | 全链路未验收；samtools 切片见对应 Actions |
| 11 稀疏特征值 | `petsc`、`slepc`、`py-petsc4py`、`py-slepc4py`、`py-scipy`、`python` | 合成 5×5 Matrix Market 矩阵 | 软件、示例及替换矩阵的数据许可 | Linux；同一 MPI provider/ABI、Python ABI、scalar/index 宽度和 BLAS；bindings 必须使用一致依赖 DAG | 未验收 |
| 12 粒子输运 | `geant4`、`root`、`cmake`、`python` | 同版本官方 B4a 示例和 Geant4 物理数据集 | 示例、各物理数据集与软件条款分别核对 | Linux；C++/ROOT/PyROOT ABI、多线程预算、数据集路径；不默认采用 MPI | 未验收 |
| 13 GIS 水文分析 | `gdal`、`grass`、`cdo`、`py-xarray`、`py-netcdf4`、`py-numpy`、`python` | 默认合成 DEM；SRTM 等真实数据另行取得 | 真实 DEM 的账号、产品和再分发条件 | Linux；GDAL Python bindings、NetCDF/HDF5；CRS、NoData、垂直基准；单节点多核不等于 MPI 验收 | 未验收 |
| 14 翼型 CFD | `su2`、`gnuplot`、`paraview`、`python` | 同一 release 的官方 NACA0012 配置与网格 | 教程、网格及软件许可 | Linux；MPI 分区、配置版本与 history 列名；可视化接口 | 未验收 |
| 15 量子化学 | `nwchem`、`py-ase`、`gnuplot`、`python` | 合成水分子、匹配基组库 | 基组、软件及示例许可 | Linux；MPI/ARMCI、Fortran/BLAS、库路径；Bohr/Angstrom 与 D 指数解析 | 未验收 |

## 首个 samtools 切片

| 固定项 | 要求 |
|---|---|
| 请求 spec | `samtools@1.19.2 ^htslib@1.19.1~libcurl~libdeflate ^ncurses+symlinks %pkgconf ^zlib@1.3.1` |
| Spack | `1.0.0` |
| 官方 recipe 来源 | `spack/spack-packages` |
| 上游 commit | `32c54f0906004d7fd1f72fd1b5970bf2bf094e26` |
| 上游 tree | `f117b6bf72ee6d9c2951922f4afd31f461b02b0d` |
| 参考目标 | Linux Ubuntu 20.04 x86_64；release 的完整 target 必须与实际 lock/profile 相符 |
| 执行环境 | GitHub Actions 可销毁单节点 Slurm，不复用生产站点 |
| 科学输入 | 小型合成 SAM，不包含个人基因组数据 |

上述 spec 是原生 concretize 的输入，不是已成功求解的 lock。
上游 commit 与人工打包后的 snapshot commit 也不是同一概念，release 必须引用
实际导入且用于 Linux 求解的快照。

准备器与受管 worker 均仅加载隔离的内部配置 scope，不额外叠加 Spack 安装目录、
用户或站点 defaults。相同 spec 和 recipe 不足以保证相同依赖 DAG；
provider preference、external 和 target 配置也必须一致。重新求解的 root/DAG hash
与 lock 不符时必须停止，不能手改 lock 或放宽校验来接受材料。

案例显式选择官方 ncurses 的 `+symlinks` 和 `pkgconf` provider，以避免其默认
替代配置中的硬链接安装产物。这些约束属于双方共同求解的请求 spec，
不是准备器私有配置，也没有改写上游 recipe。worker 仍拒绝安装树中的硬链接；
任意软件的硬链接兼容性不在本案例验收范围内。
Spack 1.0 的 `%pkgconf` 在此绑定最近的 `^ncurses` 节点，明确其直接构建依赖；
不能替换为 root 级 `^pkgconf`，后者不匹配该间接纯构建依赖。
固定 spec 使用 Spack 原生规范化顺序，在求解前检查其往返表示一致；
lock 由 Spack 原生生成，不能手工调整 `roots[].spec` 来通过绑定校验。

仅在 GitHub Actions 隔离环境中使用以下入口，不在 macOS、本地 Docker 或实际集群运行：

```bash
bash deploy/pr-test/run.sh slurm --spack-samtools
```

目标检查链为：联网准备固定材料、Registry 导入、Server 授权交付、Agent 校验、
隔离 source audit、断网受管 build、独立 readonly verify、managed load、真实 Slurm
作业与结果校验。作业需检查精确 executable 路径和版本、SAM→BAM、坐标排序、
BAM quickcheck、BAI 索引、区域计数及非法输入非零退出，不能只检查输出文件存在。
重启复验、完整性负例和清理结果也须以对应提交的实际 Actions 结果为准。

此范围不含 fastp、BWA-MEM2、bcftools、Python 分析或完整 VCF truth 校验，
不证明工作流 10 全链路、PBS、MPI、跨节点存储或生产站点兼容。
现有单次 worker 上限 30 分钟，source audit 内存 2 GiB、managed worker 内存
4 GiB、CPU 2、PID 128；实际 DAG 是否适合这些预算尚须验证，失败不能靠绕过隔离通过。

## 单 Root 与步骤隔离

每个软件准备独立的原生单 root lock 和 release；该 lock 中的全部节点必须从唯一
root 可达。不得将多个软件一起 `spack add` 后的多 root lock 上传，也不得手改、
截取或拼接 lock 来满足检查。共同依赖保留在各自 DAG 内，独立 store 可能重复构建。

每个工作流步骤只使用其对应 release 经 managed load 验证后返回的环境。
shell pipeline 两端也须分别建立环境并保留 `pipefail`，不得把全部 load shell 叠加
到一个会话。通过文件交换结果时须固定格式、单位、schema 和上下游版本。
Python bindings 与底层库必须在该 root 的依赖 DAG 内保持一致；MPI launcher、
provider 和运行库也不能从另一个 release 任意借用。单 root 方案不能自动解决
PETSc/SLEPc bindings 等同进程组合需求，相关工作流需另行验证依赖设计。

安装按 release 串行执行，每项独立记录结果。整条链路不是原子事务，后项失败不会
回滚前项；inventory/load/uninstall 只管理 root，卸载会清理其独占事务 store。
普通 workflow wrapper 的 `spack load` 不能替代 Server API 的 managed load 校验。

## macOS 获取与搬运

macOS 电脑可获取、审查、校验和搬运文件，**不能用 macOS concretize 产生的 lock
替代目标 Linux lock**。以下 Git 操作仅用于全新的材料工作目录，不修改平台源码仓库。
准备前确认有 Git、可信上游访问渠道及足够空间；本文不提供安装脚本。

### 1. 获取完整 Recipe

在新建工作目录获取固定上游版本，不以默认分支最新内容替代：

```bash
mkdir spack-material-staging
cd spack-material-staging
RECIPE_COMMIT=32c54f0906004d7fd1f72fd1b5970bf2bf094e26
RECIPE_TREE=f117b6bf72ee6d9c2951922f4afd31f461b02b0d
git init --object-format=sha1 recipe-upstream
git -C recipe-upstream remote add origin https://github.com/spack/spack-packages.git
git -C recipe-upstream fetch --depth=1 origin "$RECIPE_COMMIT"
git -C recipe-upstream checkout --detach FETCH_HEAD
git -C recipe-upstream rev-parse HEAD
git -C recipe-upstream rev-parse 'HEAD^{tree}'
git -C recipe-upstream ls-tree -r --full-tree HEAD
```

分别核对输出 commit/tree 与上述固定值，任何不一致均停止。审查完整 tree、
recipe 代码与来源可信性，保留许可、patch 和辅助模块；不能只取 samtools 的
`package.py`。发现 symlink、submodule、非法路径或超限内容时先停止并审查，
不得静默丢弃文件。固定 hash 仅证明内容一致，不证明上游或 recipe 安全。

### 2. 制作并校验自包含 Bundle

浅克隆不等于合格的自包含 bundle。为避免历史与 delta 超限，可从已审查的完整
tree 建立另一个独立快照仓库。以下操作复制全部跟踪文件，不复制上游 `.git`，
也不裁剪为单个 recipe：

```bash
mkdir recipe-snapshot recipe-pack bundle-check
git -C recipe-upstream --work-tree="$PWD/recipe-snapshot" checkout HEAD -- .
git -C recipe-snapshot init --object-format=sha1
git -C recipe-snapshot add .
git -C recipe-snapshot write-tree
```

在提交前，`write-tree` 输出必须等于已审查的 `RECIPE_TREE`；否则停止并排查文件、
权限或 Git 属性转换。确认一致后，只在这个新快照仓库创建根 commit：

```bash
git -C recipe-snapshot -c user.name="Offline Recipe Import" \
  -c user.email="operator@example.invalid" commit \
  -m "Recipe snapshot from 32c54f0906004d7fd1f72fd1b5970bf2bf094e26"
git -C recipe-snapshot rev-parse HEAD
git -C recipe-snapshot -c pack.window=0 \
  bundle create "$PWD/recipe-pack/recipes.bundle" HEAD
git bundle list-heads recipe-pack/recipes.bundle
git -C bundle-check init --bare --object-format=sha1
git -C bundle-check bundle verify "$PWD/recipe-pack/recipes.bundle"
shasum -a 256 recipe-pack/recipes.bundle
wc -c < recipe-pack/recipes.bundle
```

要求 bundle 包含 `HEAD`，且在空 `bundle-check` 仓库中验证成功，无外部 prerequisite。
记录上游 commit/tree、实际 snapshot HEAD、bundle SHA-256/字节数和审查结论；
这些交付记录与材料包分开放置。不要将新 snapshot HEAD 写成上游原始 commit。
默认 bundle 上限 128 MiB、展开上限 512 MiB、文件数上限 100,000，详见
[Recipe 仓库](spack-recipe-repositories.md)。Git 校验成功不等于 Registry 静态诊断、
目标 Spack 兼容性或许可自审通过。

### 3. 取得目标 Linux Lock 与源码闭包

若使用电脑端制作的 bundle，须先由维护者安排消费该固定 bundle 的授权 GitHub Actions
Linux 材料准备任务；现有固定案例入口不接受任意 bundle 作为输入。任务必须使用
Spack 1.0.0、同一 recipe snapshot/roots、参考 Ubuntu 20.04 x86_64 工具链和明确的
external 配置，在隔离环境中原生 concretize 每个单 root，并导出原始 `spack.lock`
与完整 source mirror。不能在 macOS 上求解后只把 `target` 字段改成 Linux。

固定 CI 准备器会自行制作 recipe snapshot。使用它的输出时，必须成套取得该任务的
bundle、lock、sources 和元数据，以该 bundle 的实际 HEAD 为准，不得替换成电脑端
另行制作的 bundle，即使二者记录了相同上游 commit。

固定案例可使用[手动材料导出工作流](spack-material-artifacts.md)生成成套导入目录，
须在实际验证成功并授权上传后取得，不预设已经存在可下载成品。
原 PR 安装验收入口仍不自动导出材料。准备器的 `metadata.json`、`recipes.bundle`、
`spack.lock`、`sources/` 原始输出也不等于 Web 材料 manifest，须经导出器或按下节组包。

接收材料前核对：

1. 记录的是实际求解结果，包括 root、Spack 版本、完整 Linux target、编译器、
   external、recipe snapshot commit 与 roots；固定案例的请求 spec 不代替这些记录。
2. 所有非 external DAG 节点的 source、resource、下载 patch 均有可校验材料；
   本地 patch 与辅助文件保留在 recipe tree。不能只下载 samtools 主源码压缩包。
3. mirror 相对路径保持 native Spack 布局，必要别名由 manifest 映射到同一 blob；
   需实体文件时使用普通文件，不以 symlink/hardlink 交付。不要按 basename 扁平化。
4. external compiler/runtime 的路径和 ABI 与目标 profile 一致；将依赖标成 external
   不等于材料已提供，也不免除目标节点可用性检查。
5. 对照接收前获知的可信 digest/大小清单逐件校验。只在下载后自行计算 digest，
   不能证明上游内容未被替换。闭包完整性仍需目标隔离 source audit 和离线 build 验证。

正式站点的 OS、CPU、compiler、MPI、Slurm/PBS、共享路径、quota、出网和 runtime
须另行确认。参考 CI lock 不自动适用于其他 Linux 或实际站点。

### 4. 组包、复核与传输

按[材料发布与导入](spack-material-delivery.md)的完整 schema 手工准备：

```text
delivery/
  recipe-pack/
    manifest.json
    recipes.bundle
  material-pack/
    manifest.json
    locks/samtools.lock
    sources/<实际选用的 mirror 相对文件路径>
  review/
    <许可、来源与交付校验记录，不随 Web 材料目录选择>
```

recipe manifest 使用 `version: 1`，`repositories` 中填写实际逻辑仓库名和
`bundlePath: "recipes.bundle"`。例如 `org/provider-example/site-recipes` 仅为
命名示例，须替换为有权限的组织 namespace。recipe repository ID 是逻辑仓库名的
摘要，不是 upstream Git URL 或 commit。

material manifest 的 `files[].path` 对应包内实体文件；`releases[].sources[].path`
对应 native mirror 相对路径，二者不要混淆。`files` 按 digest 去重并恰好覆盖全部
release 的 lock/source 引用，不允许缺件、重复路径或额外文件。release 填写实际
spec、`spackVersion`、target、recipe repository ID、snapshot commit/roots、
每项 source 和 lock 的 digest/size，以及审查后的再分发声明。recipe bundle
单独导入，不作为 source 填进 material manifest。

在 macOS 对每个实际文件使用 `shasum -a 256` 和 `wc -c` 核对摘要与字节数；
manifest 摘要使用 `sha256:` 前缀。保留原始 lock 和源码字节，不重新格式化 lock、
解压重打源码或改写 mirror 路径。不要把校验记录、额外 `.DS_Store` 文件或其他
未引用内容放进待选材料目录。

通过授权的文件传输渠道搬运整套目录，在接收端再次核对独立保存的 digest/大小。
公开交付前排除凭据、个人路径、内部主机信息和受限数据。用于 bootstrap 的清单、
文件及目录须满足普通文件、无链接和 group/other 不可写等要求，完整路径链由
管理员控制；只读挂载期间也不得在宿主修改材料。

## 导入与使用

### Bootstrap

1. 先准备 recipe manifest 和材料 manifest，并按上节核对映射及许可。
2. 将两个输入目录与 Registry 持久化输出分开，只读挂载，例如 `/imports/recipes`
   和 `/imports/materials`；服务 UID 必须能读取。
3. 配置 `SPACK_RECIPE_BOOTSTRAP_MANIFEST=/imports/recipes/manifest.json` 与
   `SPACK_MATERIAL_BOOTSTRAP_MANIFEST=/imports/materials/manifest.json`，
   在授权部署窗口启动。recipe 导入成功后才进行材料导入；已有快照的 recipe 仓库
   会跳过初始化，新版本应通过 Web/API 导入。
4. 检查 bootstrap 分类报告、逐 release 结果及成功 binding，不能以 health/readiness
   成功代替后台导入完成。批次不是原子事务，部分失败不撤销已成功项。

部署挂载和完整配置见[材料发布与导入](spack-material-delivery.md)及
[Recipe 仓库](spack-recipe-repositories.md)。

### Web

1. 登录软件中心 Spack 页或 CP 软件页，确认当前组织及发布权限。在 recipe 面板
   上传 bundle，核对实际 snapshot commit、roots 和静态诊断；必要的激活由运维
   明确审核后执行，不是上传自动完成。
2. 在 Spack 材料面板选择材料 `manifest.json`，再选择整个 `material-pack` 目录，
   保持 `files[].path` 的相对层级；可包含 manifest 本身，不能附带 recipe bundle
   或审查记录。平铺包也可按页面要求多选匹配文件。
3. 核对 namespace、spec、Linux target 和再分发声明后导入，逐项检查结果。浏览器
   不执行 Spack、不补齐缺件；schema 和 digest 校验不证明闭包或安装成功。
4. 保存成功的 `{repositoryId, manifestDigest}` binding，并查阅固定 manifest。
   取消或发布响应丢失不代表回滚；结果待确认时先核查，不宣称失败项已被删除。

导入完成不会自动设置 Server 的 `SPACK_MATERIAL_RELEASES`、启用安装、恢复下架项、
执行 recipe 或运行作业。运维须显式配置成功 binding，满足当前 lifecycle、
visibility 与 rollout 门禁，并按[实验性受管安装要求](spack-material-delivery.md)
准备可信 runtime/site profile。Agent 始终仅从 Server 获取材料，不直连 Registry
或上游，不以临时出网补齐缺失源码。

## 验收判定

材料准备、许可审查、导入、source audit、离线 build、readonly verify、managed load、
调度器执行与科学结果校验须分别给出结论。静态结构校验、文件存在、作业退出零或
某一个软件成功，都不能代替后续阶段及整个工作流验收。

失败应区分求解/recipe、缺件或 checksum、授权/门禁、ABI、构建、内存或磁盘预算、
runtime 隔离、调度器和科学结果；网络问题须有脱敏后的 DNS/TLS/HTTP/超时分类证据，
不能统一归因为网络。不得输出凭据、原始环境变量、内部路径或未经脱敏的任务日志。
新增验收结论须逐项核对对应提交的 GitHub Actions，入口与范围见
[PR 调度器测试](../deploy/pr-test/README.md)。
