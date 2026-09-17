# Mock VASP 输入

这些文本占位文件用于工作流编排与文件传输 fixture，不含 VASP 计算所需的结构、采样点或赝势数据。

`workflow-vasp-pipeline.test.ts` 在执行时将四个输入文件打包到临时目录，
结束后删除生成的归档。
