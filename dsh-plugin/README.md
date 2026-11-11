# dsh-plugin-atlas

DeepSeek Harness 的 Plugin Atlas 插件，通过本机服务搜索插件生态能力图谱、查看插件详情与服务状态。This plugin connects DeepSeek Harness to a local Plugin Atlas service.

## 工具与命令

- `plugin_atlas_search(q, limit?, mode?, include_github_only?)`：搜索插件；mode 可选 `hybrid`、`fulltext`、`semantic`。
- `plugin_atlas_node(id)`：查看节点和插件详情。
- `plugin_atlas_status()`：查看服务状态与网页地址。
- `/atlas <关键词>`：搜索插件。
- `/atlas-open`：显示网页地址和启动方法；可在浏览器或 dsh web 内置浏览器标签页打开。

## 安装与配置

将 `<仓库路径>` 换成仓库的实际绝对路径：

```sh
dsh plugin --profile headless add file:<仓库路径>/dsh-plugin
```

web profile 同理，将 `headless` 换成 `web`。卸载：

```sh
dsh plugin --profile headless remove dsh-plugin-atlas
```

插件配置支持 `baseUrl` 和 `timeoutMs`（默认 15000 毫秒）。地址优先使用 `baseUrl`，其次是环境变量 `PLUGIN_ATLAS_URL`，默认 `http://127.0.0.1:4380`。

在 profile 的 `cordis.patch.yml` 里覆盖配置的写法：

```yaml
- id: plugin-atlas
  config:
    baseUrl: http://127.0.0.1:4380
    timeoutMs: 15000
```

改完代码后，`file:` 安装是复制安装，需要先 `remove` 再 `add`；开发时可以用 `link:<仓库路径>/dsh-plugin` 代替。

如果 4380 端口的服务未启动，在仓库根目录运行 `bash web/start.sh`。首次加载约需 1–2 分钟，可用 `curl http://127.0.0.1:4380/api/status` 查看 `loading`。也可设置 `PLUGIN_ATLAS_URL` 指向其他服务地址。

## 自测

在本插件目录运行：

```sh
node test/selftest.mjs
ATLAS_LIVE=1 node test/selftest.mjs
```

第二条还会测试本机 4380 端口的真实服务。
