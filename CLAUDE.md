# CLAUDE.md — Kanban Board Tracker

Контекст проекта для Claude Code CLI. Полный регламент совместной работы — в [.agents/AGENTS.md](.agents/AGENTS.md) и [.agents/instructions/](.agents/instructions/).

## Команды запуска и управления
* Запуск трекера задач: `node tracker/server.cjs` (запускается по умолчанию на порту `5000` или через переменную окружения `TRACKER_PORT`).

## Git-workflow
* Описание коммитов на русском языке, типы коммитов — на английском (`feat`, `fix`, `docs`, `refactor`, `style`, `chore`).
* Слияние веток задач — через `/git-merge` после подтверждения пользователя, затем задача переносится в `Done`.

## Задачи (Kanban)
* Файлы задач: `.agents/tasks/{Backlog, To do, Done}/*.md`.
* Метаданные вверху файла: `id`, `assignee`, `dependencies`.
* Задачи, у которых не выполнены `dependencies` (не находятся в папке `Done`), считаются заблокированными (`Blocked`). Не брать заблокированные задачи в работу!
