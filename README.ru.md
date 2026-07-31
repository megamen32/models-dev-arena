# models-dev-arena

[English](./README.md) · **Русский** · [简体中文](./README.zh.md)

![Рабочий процесс Models.dev Arena](docs/assets/readme-hero.png)

Открытый каталог спецификаций, цен и возможностей AI-моделей на основе Models.dev, дополненный оценками Arena AI. Формула `score`, уровни доверия и правила сопоставления описаны в [INTELLIGENCE.md](./INTELLIGENCE.md). Публичная лента публикуется на <https://megamen32.github.io/models-dev-arena/>.

## Быстрый старт

Проект использует Bun workspace. Из корня репозитория одной командой установите зависимости:

```bash
bun install
```

Проверку каталога запускайте отдельно командой `bun run validate`. Для локального запуска веб-интерфейса:

```bash
cd packages/web && bun run dev
```

Отдельная база данных или сервис для работы с каталогом не нужны. Данные находятся в `models/` и `providers/`, а логотипы — в каталогах провайдеров.

## Публичный API

```bash
curl https://models.dev/api.json
curl https://models.dev/models.json
curl https://models.dev/catalog.json
curl https://models.dev/logos/{provider}.svg
```

`api.json` содержит данные о моделях у провайдеров, `models.json` — провайдеро-независимые сведения, а `catalog.json` объединяет оба набора. Для логотипа замените `{provider}` на ID провайдера.

## Изменение каталога

- Общие сведения о модели добавляются в `models/<provider>/<model>.toml`.
- Данные конкретного провайдера добавляются в `providers/<provider>/models/`.
- Для повторного использования общих сведений используйте `base_model`; не добавляйте `id` вручную — он берётся из имени TOML-файла.
- После изменений запускайте `bun run validate`.
- Для обновления оценок Arena используйте `bun run arena:sync`, для синхронизации моделей — `bun run models:sync`.
- При переносе общих полей проверяйте результат через `bun run compare:migrations`.

Подробная схема полей, примеры TOML, синхронизация провайдеров и ручная проверка через OpenCode описаны в [английской документации](./README.md) и [sync.md](./sync.md).

## Лицензия

См. [LICENSE](./LICENSE).
