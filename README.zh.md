# models-dev-arena

[English](./README.md) · [Русский](./README.ru.md) · **简体中文**

![Models.dev Arena 工作流](docs/assets/readme-hero.png)

这是一个基于 Models.dev 的开放 AI 模型目录，包含模型规格、价格、能力以及本分支加入的 Arena AI 智能评分。`score` 公式、置信度等级和匹配规则见 [INTELLIGENCE.md](./INTELLIGENCE.md)。公开数据源发布在 <https://megamen32.github.io/models-dev-arena/>。

## 快速开始

项目使用 Bun workspace。在仓库根目录执行下面的一条命令即可安装依赖：

```bash
bun install
```

使用 `bun run validate` 单独校验目录。安装后启动本地网页界面：

```bash
cd packages/web && bun run dev
```

本地数据维护不需要单独的数据库或服务。目录数据位于 `models/` 和 `providers/`，供应商图标位于各供应商目录中。

## 公共 API

```bash
curl https://models.dev/api.json
curl https://models.dev/models.json
curl https://models.dev/catalog.json
curl https://models.dev/logos/{provider}.svg
```

`api.json` 提供供应商模型数据，`models.json` 提供与供应商无关的模型信息，`catalog.json` 合并两者。获取图标时，将 `{provider}` 替换为供应商 ID。

## 修改目录

- 通用模型信息放在 `models/<provider>/<model>.toml`。
- 供应商特定信息放在 `providers/<provider>/models/`。
- 可用 `base_model` 复用通用信息；不要手动写 `id`，它会从 TOML 文件名自动生成。
- 修改后运行 `bun run validate`。
- 使用 `bun run arena:sync` 更新 Arena 评分，使用 `bun run models:sync` 同步模型。
- 拆分通用字段时使用 `bun run compare:migrations` 比较生成结果。

字段完整定义、TOML 示例、供应商同步和 OpenCode 手动测试见[英文文档](./README.md)及 [sync.md](./sync.md)。

## 许可证

见 [LICENSE](./LICENSE)。
