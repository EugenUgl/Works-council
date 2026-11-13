# Документация `dsh-plugin-delegate-io`

Карта страниц. **Начинайте отсюда** — это правило проекта
(см. [`../AGENTS.md`](../AGENTS.md)).

## Порядок чтения

1. [`../README.md`](../README.md) — что это, зачем, как запустить.
2. Эта страница — выбираете страницу по задаче.
3. Профильная страница из таблицы ниже.
4. Только теперь — код.

## Что менять → что прочитать сначала

  Задача   Страницы  
 --- --- 
  Понять, как делегирование устроено в целом   [`architecture.md`](architecture.md)  
  Добавить/убрать перехватываемый инструмент   [`architecture.md`](architecture.md), [`configuration.md`](configuration.md)  
  Поменять жизненный цикл воркера, очередь, рецикл   [`workers.md`](workers.md)  
  Трогать лимит контекста воркера или компакцию   [`workers.md`](workers.md), [`decisions.md`](decisions.md)  
  Менять обрезку результата, спилл, дайджест   [`results-and-budget.md`](results-and-budget.md)  
  Менять проверку `write`/`edit`   [`verification.md`](verification.md)  
  Менять `delegate_think` / `delegate_inspect` / `delegate_io_status`   [`tools.md`](tools.md)  
  Добавить поле конфига или поменять `cordis.patch.yml`   [`configuration.md`](configuration.md)  
  Менять форму настроек (`client.js`)   [`configuration.md`](configuration.md)  
  Писать тесты, разбираться с регрессией   [`testing.md`](testing.md)  
  Понять, почему сделано «странно»   [`decisions.md`](decisions.md)  
  Выпустить версию, вести рабочий процесс   [`development.md`](development.md)  

## Страницы

  Страница   О чём  
 --- --- 
  [`architecture.md`](architecture.md)   Компоненты, поток одного вызова, клоны инструментов, **инварианты**  
  [`workers.md`](workers.md)   Пул воркеров (3/3/3/1), ленивый запуск, очередь и выбор слота, **когда слот заменяется** (лимит контекста, пропавшая сессия, незавершившийся ход), таймауты, наблюдение за событиями  
  [`results-and-budget.md`](results-and-budget.md)   `budgetText`, спилл, `spill` vs `summary`  
  [`verification.md`](verification.md)   Снимок до, сверка после, автоисправление, `delegateIoVerification`  
  [`tools.md`](tools.md)   Контракты трёх глобальных инструментов и их промпты  
  [`configuration.md`](configuration.md)   Все поля `Config`, `.volatile()`, форма настроек, сохранение  
  [`testing.md`](testing.md)   Что покрывает каждый тест, как добавлять, стаб-харнесс  
  [`decisions.md`](decisions.md)   Журнал архитектурных решений (ADR) и отвергнутые варианты  
  [`development.md`](development.md)   Рабочий процесс, чек-лист правки, чек-лист выпуска, техдолг  

## Соглашения этой документации

- Пути к коду указываются как `файл:строка` (например, `index.js:1262`).
- Символы в бэктиках — точные имена из кода.
- Каждая страница отвечает на вопрос «что здесь можно сломать» — не только
  «как это работает».
- Расхождение документации и кода — **баг**. Сначала правьте документацию.
