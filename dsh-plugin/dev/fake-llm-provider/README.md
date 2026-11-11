# Atlas 本地假模型

此开发插件在本地生成确定性回复，用于验证 Atlas 的 `ctx.llm` 和 `ctx.agentDefaultModel`，不访问模型服务。使用独立的 dsh profile（例如通过 `dsh --profile atlas-fake --from-default-profile headless` 创建），通过 `dsh plugin --profile atlas-fake add "file:$(pwd)/dsh-plugin/dev/fake-llm-provider"`（在仓库根目录执行）安装本包，并确保 profile 的 `dsh.profile.bundles` 启用 `dsh-atlas-fake-llm`。在该 profile 的配置中将 `agent-default-model` 的 `provider` 设为 `atlas-fake`、`model` 设为 `fake-1`，并清除可能覆盖默认选择的已保存模型设置。使用 `dsh --profile atlas-fake` 启动；通过该默认模型发出的请求只走本地假适配器，不消耗真实模型额度。显式指定其他 provider 的请求不受默认模型设置约束；若要确保整个 profile 均不调用真实模型，还需移除或禁用其他 provider 和显式模型路由。
