window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-delegate-io',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // README встроен в этот же файл, а не импортируется: загрузчик бандла
    // резолвит только платформенные модули и на `require('./readme.js')`
    // отказывает целиком — DSH после этого не запускается (D19).
    // Текст между маркерами — собственность scripts/build-readme.mjs:
    // руками не править, npm test падает, если он устарел.
    // README-НАЧАЛО
    const README_MARKDOWN = `
# dsh-plugin-delegate-io

DSH-плагин, который уводит **чтение файлов, чтение веб-страниц и запись файлов**
основного агента в делегированных субагентов — с отдельной моделью-воркером для
каждого типа задачи — и при этом **не меняет имена инструментов**, которыми
пользуется основной агент.

Пакет: \`@local/dsh-plugin-delegate-io\` · версия \`0.3.0\` · ESM · только для DSH desktop.

---

## Зачем это нужно

Основной агент видит результат инструмента, но **не платит контекстом** за
промежуточную работу воркера. Это особенно заметно на тяжёлых шагах:
большой файл, длинная веб-страница, аккуратная правка кода. Воркер выполняет
вызов в своей сессии, его транскрипт остаётся у него, а в контекст главного
агента попадает только результат — с бюджетом по размеру.

Побочно плагин даёт:

- **дешёвый обзор файла** вместо сырого содержимого (\`delegate_inspect\`);
- **рассуждающего воркера** для шага, который зашёл в тупик (\`delegate_think\`);
- **проверку делегированной записи** по файлу на диске с автоисправлением;
- **живую телеметрию** (\`delegate_io_status\`);
- **страницу настроек** в GUI, которая меняет всех этих воркеров без перезагрузки.

## Что перехватывается

| Тип задачи | Инструменты | Воркер | Включён по умолчанию |
|---|---|---|---|
| \`read\` | \`read\` | file reader | да |
| \`web\` | \`web_fetch\`, \`web_search\` | web reader | да |
| \`write\` | \`write\`, \`edit\` | file writer | да |
| \`think\` | — (глобальный \`delegate_think\`) | thinker | нет |

Основной агент продолжает вызывать \`read\`/\`write\`/… как обычно. Плагин
**регистрирует клон инструмента на корневом агенте**, клон затеняет настоящий
только для этого агента, а делегированные дети прозрачно спускаются к
настоящему инструменту. Подробнее — [\`docs/architecture.md\`](docs/architecture.md).

## Главные понятия

- **Клон инструмента** — обёртка с тем же именем и \`parameters\`, зарегистрированная
  на корневом агенте. Отдаёт либо настоящий результат, либо \`{ 'delegate-io': { text } }\`.
- **Пул воркеров** — на каждый тип задачи: \`read\`, \`web\`, \`write\` — по три
  сессии, \`think\` — одна. Вызов уходит в свободный слот, поэтому параллельные
  чтения больше не ждут друг друга. Размер пула — константа кода, а не
  настройка.
- **Воркер** — резидентная дочерняя сессия внутри пула, с очередью вызовов.
  Запускается лениво: сначала при первом вызове задачи, затем при первом
  вызове конкретного слота.
- **Спилл** — полный результат, сохранённый в \`ctx.spillStore\`; агенту уходят
  голова и хвост плюс подсказка, где лежит копия.
- **Fallback** — при сбое воркера инструмент выполняется напрямую в основном агенте.
- **Верификация** — сверка файла на диске с ожидаемым содержимым, с автоисправлением.

## Известные ограничения

- \`write\`/\`edit\` не верифицируются для файлов > 2 МБ (\`VERIFY_MAX_BYTES\`).
- Изменения **одного** файла всегда выполняются последовательно: два \`edit\`
  одного пути не пойдут параллельно, даже в пуле из трёх писателей. Иначе
  второй перезаписал бы файл по устаревшему снимку и потерял первую правку.
  Блокировка берётся по каноническому пути, поэтому \`a.txt\` и \`./a.txt\` — один
  файл. Разные файлы пишутся параллельно.
- Лимит контекста воркера измеряется по \`tokenMeter.measure().surfaceTokens\`;
  маршрутизированные инструменты и системный промпт в эту цифру не входят.
  Почему так — см. [\`docs/decisions.md\`](docs/decisions.md#d3-почему-surfacetokens-а-не-contextpressure).
- Верификация \`edit\` не различает «\`old_string\` встречается один раз» и
  «встречается несколько раз, но \`replace_all\` выключен» — в обоих случаях
  предсказывается правка первого вхождения.
- Плагин меняет поведение только корневых агентов; делегированные дети
  работают с настоящими инструментами.
- Воркер заменяется, только когда сессия больше не может работать (лимит
  контекста, пропавшая сессия, незавершившийся ход). \`maxJobsPerWorker\` и
  \`workerIdleMs\` пока не влияют на жизненный цикл — см.

## Лицензия

Внутренний (\`private: true\`) локальный пакет, не публикуется.

    `;
    // README-КОНЕЦ

    /** Page copy. */
    const en = {
      // Только accessible name для tablist: видимого заголовка карточка не
      // рисует — его даёт хост из locale/*.json.
      tabsLabel: 'Worker models and README',
      tabSettings: 'Settings',
      tabReadme: 'README',
      read: 'File reading',
      web: 'Web reading',
      write: 'File writing',
      think: 'Reasoning',
      readHint: 'read',
      webHint: 'web_fetch and web_search',
      writeHint: 'write and edit',
      thinkHint: 'delegate_think',
      thinkHelp: 'Escalated to only when a step is stuck or consequential. The thinker sees only the evidence the main agent supplies and returns a diagnosis with a next step.',
      thinkRounds: 'Clarification rounds',
      thinkEscalateAfter: 'Suggest the thinker after N failures',
      enable: 'Delegate to a subagent',
      provider: 'Provider',
      model: 'Model',
      effort: 'Reasoning effort',
      effortPlaceholder: 'model default',
      contextLimit: 'Context limit, tokens',
      contextLimitHint: 'When this worker\'s history passes the limit it is compacted before the next task; a worker that cannot be brought back under the limit is replaced. 0 keeps it unlimited.',
      inherit: 'Inherit main agent',
      pickProvider: 'Choose a provider first',
      pairHint: 'Set both provider and model, or leave both empty.',
      limits: 'Delegation',
      subagentProvider: 'Subagent backend',
      requestTimeout: 'Call timeout, ms',
      maxJobs: 'Calls per worker session',
      workerIdle: 'Idle lifetime, ms',
      resultBudget: 'Result budget, characters',
      resultBudgetHint: 'A longer result is spilled; the main agent gets head, tail, and where the rest was saved. 0 keeps every result whole.',
      verifyWrites: 'Verify delegated writes against the file on disk',
      inspectEnabled: 'Expose delegate_inspect (a worker report about a path)',
      inspectBudget: 'Report budget, characters',
      depthBudget: 'Snippet depth',
      depthOverview: 'Overview (25 lines)',
      depthNormal: 'Normal (40 lines)',
      depthThorough: 'Thorough (80 lines)',
      budgetStrategy: 'Past the budget',
      budgetSpill: 'Head and tail',
      budgetSummary: 'Worker digest',
      budgetStrategyHint: 'A worker digest costs one extra model pass; it is always marked and keeps the saved copy hint.',
      fallback: 'Run directly when the worker fails',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      savedPending: 'Saved to the profile; applies after the plugin reloads.',
      failed: 'The deployment did not accept these values.',
      unavailable: 'This plugin row is not served by the Host, so its values cannot be edited.',
      readOnly: 'This deployment stores settings read-only.',
      noModels: 'The model catalog is unavailable; type provider and model names.',
      loadingValues: 'Loading current values…',
      unsaved: 'Unsaved changes',
    };

    /** Russian copy. */
    const ru = {
      tabsLabel: 'Модели воркеров и README',
      tabSettings: 'Настройки',
      tabReadme: 'README',
      read: 'Чтение файлов',
      web: 'Чтение веб-страниц',
      write: 'Запись файлов',
      think: 'Рассуждение',
      readHint: 'read',
      webHint: 'web_fetch и web_search',
      writeHint: 'write и edit',
      thinkHint: 'delegate_think',
      thinkHelp: 'Вызывается только когда шаг зашёл в тупик или решение дорого стоит. Мыслитель видит лишь те факты, что передал основной агент, и возвращает диагноз со следующим шагом.',
      thinkRounds: 'Раундов уточнения',
      thinkEscalateAfter: 'Предлагать мыслителя после N сбоев',
      enable: 'Делегировать субагенту',
      provider: 'Провайдер',
      model: 'Модель',
      effort: 'Уровень рассуждений',
      effortPlaceholder: 'по умолчанию',
      contextLimit: 'Лимит контекста, токенов',
      contextLimitHint: 'Когда история воркера превышает лимит, перед следующей задачей она компактится; воркер, который не удаётся вернуть под лимит, пересоздаётся. 0 — без ограничения.',
      inherit: 'Наследовать у основного агента',
      pickProvider: 'Сначала выберите провайдера',
      pairHint: 'Укажите и провайдера, и модель — или оставьте оба поля пустыми.',
      limits: 'Делегирование',
      subagentProvider: 'Бэкенд субагентов',
      requestTimeout: 'Таймаут вызова, мс',
      maxJobs: 'Вызовов на сессию воркера',
      workerIdle: 'Время простоя, мс',
      resultBudget: 'Бюджет результата, символов',
      resultBudgetHint: 'Более длинный результат сохраняется, а основной агент получает начало, конец и место, где лежит остальное. 0 — отдавать результат целиком.',
      verifyWrites: 'Проверять делегированную запись по файлу на диске',
      inspectEnabled: 'Включить delegate_inspect (отчёт воркера по пути)',
      inspectBudget: 'Бюджет отчёта, символов',
      depthBudget: 'Глубина фрагментов',
      depthOverview: 'Обзор (25 строк)',
      depthNormal: 'Обычная (40 строк)',
      depthThorough: 'Подробная (80 строк)',
      budgetStrategy: 'Сверх бюджета',
      budgetSpill: 'Начало и конец',
      budgetSummary: 'Дайджест воркера',
      budgetStrategyHint: 'Дайджест стоит одного дополнительного прохода модели; он всегда помечается и сохраняет ссылку на полную копию.',
      fallback: 'Выполнять напрямую при сбое воркера',
      save: 'Сохранить',
      saving: 'Сохранение…',
      saved: 'Сохранено',
      savedPending: 'Записано в профиль; применится после перезагрузки плагина.',
      failed: 'Развёртывание не приняло эти значения.',
      unavailable: 'Строка плагина не обслуживается хостом, поэтому значения нельзя изменить.',
      readOnly: 'В этом развёртывании настройки только для чтения.',
      noModels: 'Каталог моделей недоступен — введите провайдера и модель вручную.',
      loadingValues: 'Загрузка текущих значений…',
      unsaved: 'Есть несохранённые изменения',
    };

    const TASKS = ['read', 'web', 'write', 'think'];
    const HINTS = { read: 'readHint', web: 'webHint', write: 'writeHint', think: 'thinkHint' };

    /** Settings namespace: the Host plugin's exported `name`. */
    const NAMESPACE = 'delegate-io';
    /** Bundle package name: the key the bundle page dispatches. */
    const BUNDLE_NAME = '@local/dsh-plugin-delegate-io';
    /** Row key on the bundle page: `<package name>#<row id>`. */
    const ROW_KEY = `${BUNDLE_NAME}#${NAMESPACE}`;

    /** Defaults mirroring the Host config schema. */
    const DEFAULTS = {
      subagentProvider: 'spawn',
      requestTimeoutMs: 900000,
      fallbackToDirect: true,
      maxJobsPerWorker: 25,
      workerIdleMs: 600000,
      maxResultChars: 12000,
      verifyWrites: true,
      inspectEnabled: true,
      inspectMaxChars: 4000,
      depthBudget: 'normal',
      budgetStrategy: 'spill',
      thinkMaxTurns: 2,
      thinkEscalateAfter: 2,
    };
    for (const task of TASKS) {
      DEFAULTS[`${task}Enabled`] = true;
      DEFAULTS[`${task}Provider`] = '';
      DEFAULTS[`${task}Model`] = '';
      DEFAULTS[`${task}ReasoningEffort`] = '';
      DEFAULTS[`${task}MaxContextTokens`] = 0;
    }
    // The thinker is opt-in and reasons by default: leaving its effort empty
    // would inherit the main agent's route, which is the very thing it exists
    // to replace.
    DEFAULTS.thinkEnabled = false;
    DEFAULTS.thinkReasoningEffort = 'high';

    /** Copy the Host form value into a flat draft. */
    function draftOf(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      const draft = {};
      for (const [key, fallback] of Object.entries(DEFAULTS)) {
        const current = source[key];
        draft[key] = current === undefined || current === null ? fallback : current;
      }
      return draft;
    }

    /** Two drafts are equal field by field. */
    function sameDraft(left, right) {
      return Object.keys(DEFAULTS).every((key) => left[key] === right[key]);
    }

    /** Normalize one catalog model, keeping the reasoning metadata the form needs. */
    function modelOf(raw) {
      if (typeof raw === 'string') return { id: raw, name: raw, efforts: [] };
      if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') return undefined;
      const reasoning = raw.reasoning !== null && typeof raw.reasoning === 'object' ? raw.reasoning : undefined;
      const efforts = Array.isArray(reasoning?.efforts)
        ? reasoning.efforts
            .map((effort) => {
              if (typeof effort === 'string') return { id: effort, name: effort };
              if (effort === null || typeof effort !== 'object' || typeof effort.id !== 'string') return undefined;
              return { id: effort.id, name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id };
            })
            .filter(Boolean)
        : [];
      return {
        id: raw.id,
        name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
        efforts,
      };
    }

    /** Flatten the catalog answer into `{ id, name, models }` groups. */
    function catalogGroups(value) {
      const raw = Array.isArray(value?.groups) ? value.groups : Array.isArray(value) ? value : [];
      const groups = [];
      for (const entry of raw) {
        if (entry === null || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id : typeof entry.provider === 'string' ? entry.provider : '';
        if (id === '') continue;
        groups.push({
          id,
          name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
          models: (Array.isArray(entry.models) ? entry.models : []).map(modelOf).filter(Boolean),
        });
      }
      return groups;
    }

    /** The Host-backed form for this row, or undefined when the service is absent. */
    function formScopeOf(ctx) {
      try {
        const forms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined;
        return forms === undefined ? undefined : forms.get(NAMESPACE);
      } catch {
        return undefined;
      }
    }

    const controlStyle = {
      font: 'inherit',
      fontSize: 13,
      color: 'var(--dsw-alias-label-primary)',
      background: 'transparent',
      border: '0.5px solid var(--dsw-alias-border-l4)',
      borderRadius: 'var(--dsw-radius-md, 6px)',
      padding: '5px 8px',
      minWidth: 0,
      width: '100%',
      boxSizing: 'border-box',
      maxWidth: '100%',
    };
    const fieldStyle = { display: 'grid', gap: 4, minWidth: 0, flex: '1 1 190px' };
    const labelStyle = { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' };
    const sectionStyle = { borderTop: '0.5px solid var(--dsw-alias-border-l2)', padding: '16px 0', display: 'grid', gap: 12 };

    /** One labelled control. */
    function field(label, control) {
      return h('label', { style: fieldStyle }, h('span', { style: labelStyle }, label), control);
    }

    /** A select whose saved value survives even when the catalog no longer lists it. */
    function select(value, options, props) {
      return h('select', { style: controlStyle, value, ...props }, options);
    }

    /**
     * The page: a tab bar over the settings form and the README.
     *
     * Состояние `draft`/`busy`/`notice` держится здесь, а не внутри панели
     * настроек: переключение на README и обратно не должно терять
     * несохранённые правки формы. Ранние выходы (сводка, недоступный хост,
     * загрузка) стоят до вычисления `writable`, поэтому вкладка README
     * недоступна именно там, где формы нет вовсе.
     */
    function Card(props) {
      const t = props.t;
      const scope = props.scope;
      // README открыт первым: страница плагина открывается для знакомства, а
      // не для правки лимитов, и справочник отвечает на «что это вообще».
      const [tab, setTab] = React.useState('readme');
      const [snapshot, setSnapshot] = React.useState(() => (scope === undefined ? undefined : scope.getSnapshot()));
      const source = React.useMemo(() => draftOf(snapshot?.value), [snapshot?.value]);
      const [draft, setDraft] = React.useState(source);
      const [catalog, setCatalog] = React.useState(props.hostStore.current);
      const [models, setModels] = React.useState({ status: 'loading', groups: [] });
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const draftRef = React.useRef(draft);
      const lastSource = React.useRef(source);
      draftRef.current = draft;

      React.useEffect(() => {
        if (scope === undefined) return undefined;
        setSnapshot(scope.getSnapshot());
        return scope.subscribe(() => setSnapshot(scope.getSnapshot()));
      }, [scope]);

      React.useEffect(() => props.hostStore.subscribe(() => setCatalog(props.hostStore.current)), [props.hostStore]);

      React.useEffect(() => {
        if (catalog === undefined) return undefined;
        let live = true;
        catalog.load().then(
          (groups) => {
            if (live) setModels({ status: 'ready', groups });
          },
          () => {
            if (live) setModels({ status: 'error', groups: [] });
          },
        );
        return () => {
          live = false;
        };
      }, [catalog]);

      React.useEffect(() => {
        const next = draftOf(snapshot?.value);
        const edited = !sameDraft(draftRef.current, lastSource.current);
        lastSource.current = next;
        if (!edited) setDraft(next);
      }, [snapshot?.value]);

      // Хост вызывает слот ДВАЖДЫ на странице строки: `summary` — в строке
      // описания (`.detailDesc`), и `page` — в секции конфигурации. Раньше
      // `summary` отдавал текст, а `page` — вкладки; в итоге переключатель
      // вкладок появлялся над README ещё раз, уже под самим README.
      // Сворачивать сюда нечего: описание строки — данные хоста из locale,
      // см. docs/decisions.md → D22.
      if (props.view === 'summary') return null;
      const tabs = h(
        'div',
        { role: 'tablist', 'aria-label': t('tabsLabel'), style: tabBarStyle },
        tabButton(tab === 'readme', t('tabReadme'), () => setTab('readme')),
        tabButton(tab === 'settings', t('tabSettings'), () => setTab('settings')),
      );
      if (tab === 'readme') {
        return h('div', { style: { display: 'grid', gap: 0 } }, tabs, React.createElement(ReadmePanel, { markdown: README_MARKDOWN, t }));
      }
      if (scope === undefined || snapshot === undefined || snapshot.status === 'unavailable') {
        return h(
          'div',
          { style: { display: 'grid', gap: 0 } },
          tabs,
          h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('unavailable')),
        );
      }
      if (snapshot.status !== 'ready') {
        return h(
          'div',
          { style: { display: 'grid', gap: 0 } },
          tabs,
          h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('loadingValues')),
        );
      }

      const writable = snapshot.writable === true;
      const dirty = !sameDraft(draft, source);
      const groups = models.groups;
      const hasCatalog = groups.length > 0;

      /** Change one draft field. */
      const edit = (key, value) => {
        setDraft((current) => ({ ...current, [key]: value }));
        setNotice('');
      };

      /** Change one numeric draft field, refusing an entry the schema rejects. */
      const editCount = (key, raw) => {
        if (String(raw).trim() === '') return; // keep the last valid number
        const value = Math.floor(Number(raw));
        if (!Number.isFinite(value) || value < 0) return;
        edit(key, value);
      };

      /** Persist the staged values as one atomic Host mutation. */
      const save = async () => {
        if (!writable || busy || !dirty) return;
        setBusy(true);
        setNotice('');
        // Send only the fields this form actually changed. A field the running
        // Host does not declare (an older plugin build without the per-worker
        // context limit) would otherwise reject the whole mutation with
        // `Config field "<key>" is not volatile`.
        const ops = Object.keys(DEFAULTS)
          .filter((key) => draft[key] !== lastSource.current[key])
          .map((key) => ({ op: 'set', path: [key], value: draft[key] }));
        try {
          const host = props.hostStore.current;
          if (host !== undefined) {
            const result = await host.save(ops);
            if (result.ok === true) {
              // Adopt the Host's post-write values so the form and the running
              // plugin can never disagree, even when the invalidation event
              // arrives late or not at all.
              if (result.value !== undefined) {
                const adopted = draftOf(result.value);
                lastSource.current = adopted;
                draftRef.current = adopted;
                setDraft(adopted);
                // The profile patch holds the new values as soon as the write
                // is accepted, but the running row republishes them only after
                // it reloads. Say so instead of claiming a live application.
                if (!sameDraft(adopted, draft)) {
                  setNotice(t('savedPending'));
                  return;
                }
              }
              setNotice(t('saved'));
            } else {
              setNotice(result.message);
            }
          } else {
            const accepted = await scope.mutate(ops, snapshot.revision);
            setNotice(accepted === false ? t('failed') : t('saved'));
          }
        } catch (error) {
          setNotice(`${t('failed')} ${String(error?.message ?? error)}`);
        } finally {
          setBusy(false);
        }
      };

      const groupOf = (task) => groups.find((group) => group.id === draft[`${task}Provider`].trim());
      const modelOfTask = (task) => groupOf(task)?.models.find((model) => model.id === draft[`${task}Model`].trim());

      const providerControl = (task) => {
        const key = `${task}Provider`;
        const value = draft[key];
        if (!hasCatalog) {
          return h('input', {
            type: 'text',
            style: controlStyle,
            placeholder: t('inherit'),
            value,
            disabled: !writable || busy || draft[`${task}Enabled`] === false,
            onChange: (event) => edit(key, event.target.value),
          });
        }
        const options = [h('option', { key: '', value: '' }, t('inherit'))];
        for (const group of groups) options.push(h('option', { key: group.id, value: group.id }, group.name));
        if (value !== '' && !groups.some((group) => group.id === value)) {
          options.push(h('option', { key: `saved-${value}`, value }, value));
        }
        return select(value, options, {
          disabled: !writable || busy || draft[`${task}Enabled`] === false,
          onChange: (event) => {
            const provider = event.target.value;
            const group = groups.find((candidate) => candidate.id === provider);
            const keepsModel = group !== undefined && group.models.some((model) => model.id === draft[`${task}Model`]);
            setDraft((current) => ({
              ...current,
              [`${task}Provider`]: provider,
              [`${task}Model`]: keepsModel ? current[`${task}Model`] : '',
            }));
            setNotice('');
          },
        });
      };

      const modelControl = (task) => {
        const key = `${task}Model`;
        const value = draft[key];
        const group = groupOf(task);
        if (!hasCatalog || group === undefined) {
          const inheriting = draft[`${task}Provider`].trim() === '';
          return h('input', {
            type: 'text',
            style: controlStyle,
            placeholder: inheriting ? t('inherit') : t('model'),
            value,
            disabled: !writable || busy || draft[`${task}Enabled`] === false || (hasCatalog && inheriting),
            onChange: (event) => edit(key, event.target.value),
          });
        }
        const options = [h('option', { key: '', value: '' }, t('inherit'))];
        for (const model of group.models) options.push(h('option', { key: model.id, value: model.id }, model.name));
        if (value !== '' && !group.models.some((model) => model.id === value)) {
          options.push(h('option', { key: `saved-${value}`, value }, value));
        }
        return select(value, options, {
          disabled: !writable || busy || draft[`${task}Enabled`] === false,
          onChange: (event) => edit(key, event.target.value),
        });
      };

      const effortControl = (task) => {
        const key = `${task}ReasoningEffort`;        const value = draft[key];
        const model = modelOfTask(task);
        const efforts = model?.efforts ?? [];
        if (efforts.length === 0) {
          return h('input', {
            type: 'text',
            style: controlStyle,
            placeholder: t('effortPlaceholder'),
            value,
            disabled: !writable || busy || draft[`${task}Enabled`] === false,
            onChange: (event) => edit(key, event.target.value),
          });
        }
        const options = [h('option', { key: '', value: '' }, t('effortPlaceholder'))];
        for (const effort of efforts) options.push(h('option', { key: effort.id, value: effort.id }, effort.name));
        if (value !== '' && !efforts.some((effort) => effort.id === value)) {
          options.push(h('option', { key: `saved-${value}`, value }, value));
        }
        return select(value, options, {
          disabled: !writable || busy || draft[`${task}Enabled`] === false,
          onChange: (event) => edit(key, event.target.value),
        });
      };

      /** Context limit of one worker, in tokens; 0 leaves the worker unlimited. */
      const contextControl = (task) => {
        const key = `${task}MaxContextTokens`;
        return h('input', {
          type: 'number',
          min: 0,
          step: 1000,
          style: { ...controlStyle, maxWidth: 200 },
          value: draft[key],
          placeholder: '0',
          disabled: !writable || busy || draft[`${task}Enabled`] === false,
          onChange: (event) => editCount(key, event.target.value),
        });
      };

      const sections = TASKS.map((task) => {
        const enabled = draft[`${task}Enabled`] !== false;
        const provider = draft[`${task}Provider`];
        const model = draft[`${task}Model`];
        const paired = (provider.trim() === '') === (model.trim() === '');
        return h(
          'section',
          { key: task, style: sectionStyle },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            h('h3', { style: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t(task)),
            h('code', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, t(HINTS[task])),
          ),
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              disabled: !writable || busy,
              onChange: (event) => edit(`${task}Enabled`, event.target.checked),
            }),
            t('enable'),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 12, flexWrap: 'wrap', opacity: enabled ? 1 : 0.5 } },
            field(t('provider'), providerControl(task)),
            field(t('model'), modelControl(task)),
            field(t('effort'), effortControl(task)),
            field(t('contextLimit'), contextControl(task)),
          ),
          h(
            'p',
            { style: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } },
            t('contextLimitHint'),
          ),
          paired ? null : h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('pairHint')),
          task !== 'think'
            ? null
            : h(
                'div',
                { style: { display: 'grid', gap: 8, opacity: enabled ? 1 : 0.5 } },
                h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } }, t('thinkHelp')),
                h(
                  'div',
                  { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
                  field(
                    t('thinkRounds'),
                    h('input', {
                      type: 'number',
                      min: 0,
                      step: 1,
                      style: { ...controlStyle, maxWidth: 200 },
                      value: draft.thinkMaxTurns,
                      disabled: !writable || busy || !enabled,
                      onChange: (event) => editCount('thinkMaxTurns', event.target.value),
                    }),
                  ),
                  field(
                    t('thinkEscalateAfter'),
                    h('input', {
                      type: 'number',
                      min: 0,
                      step: 1,
                      style: { ...controlStyle, maxWidth: 200 },
                      value: draft.thinkEscalateAfter,
                      disabled: !writable || busy || !enabled,
                      onChange: (event) => editCount('thinkEscalateAfter', event.target.value),
                    }),
                  ),
                ),
              ),
        );
      });

      return h(
        'div',
        { style: { display: 'grid', gap: 0 } },
        tabs,
        h(
          'section',
          { role: 'tabpanel', style: { display: 'grid', gap: 0 } },
          // Заголовка и описания здесь нет намеренно: хост уже нарисовал над
          // карточкой название строки и её описание из locale/*.json. Свой
          // `<h2>` с абзацем дублировал их (см. docs/decisions.md → D20).
          models.status === 'error'
            ? h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('noModels'))
            : null,
          sections,
          h(
            'section',
            { style: sectionStyle },
            h('h3', { style: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('limits')),
            h(
              'div',
              { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
              field(
                t('subagentProvider'),
                h('input', {
                  type: 'text',
                  style: { ...controlStyle, maxWidth: 200 },
                  value: draft.subagentProvider,
                  disabled: !writable || busy,
                  onChange: (event) => edit('subagentProvider', event.target.value),
                }),
              ),
              field(
                t('requestTimeout'),
                h('input', {
                  type: 'number',
                  min: 1000,
                  step: 1000,
                  style: { ...controlStyle, maxWidth: 200 },
                  value: draft.requestTimeoutMs,
                  disabled: !writable || busy,
                  onChange: (event) => editCount('requestTimeoutMs', event.target.value),
                }),
              ),
              field(
                t('maxJobs'),
                h('input', {
                  type: 'number',
                  min: 1,
                  step: 1,
                  style: { ...controlStyle, maxWidth: 200 },
                  value: draft.maxJobsPerWorker,
                  disabled: !writable || busy,
                  onChange: (event) => editCount('maxJobsPerWorker', event.target.value),
                }),
              ),
              field(
                t('workerIdle'),
                h('input', {
                  type: 'number',
                  min: 0,
                  step: 60000,
                  style: { ...controlStyle, maxWidth: 200 },
                  value: draft.workerIdleMs,
                  disabled: !writable || busy,
                  onChange: (event) => editCount('workerIdleMs', event.target.value),
                }),
              ),
              field(
                t('resultBudget'),
                h('input', {
                  type: 'number',
                  min: 0,
                  step: 1000,
                  style: { ...controlStyle, maxWidth: 200 },
                  value: draft.maxResultChars,
                  disabled: !writable || busy,
                  onChange: (event) => editCount('maxResultChars', event.target.value),
                }),
              ),
            ),
            h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } }, t('resultBudgetHint')),
            h(
              'div',
              { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
              field(
                t('budgetStrategy'),
                select(draft.budgetStrategy, [
                  h('option', { key: 'spill', value: 'spill' }, t('budgetSpill')),
                  h('option', { key: 'summary', value: 'summary' }, t('budgetSummary')),
                ], {
                  disabled: !writable || busy,
                  onChange: (event) => edit('budgetStrategy', event.target.value),
                }),
              ),
              field(
                t('inspectBudget'),
                h('input', {
                  type: 'number',
                  min: 0,
                  step: 500,
                  style: { ...controlStyle, maxWidth: 200 },
                  value: draft.inspectMaxChars,
                  disabled: !writable || busy,
                  onChange: (event) => editCount('inspectMaxChars', event.target.value),
                }),
              ),
              field(
                t('depthBudget'),
                select(draft.depthBudget, [
                  h('option', { key: 'overview', value: 'overview' }, t('depthOverview')),
                  h('option', { key: 'normal', value: 'normal' }, t('depthNormal')),
                  h('option', { key: 'thorough', value: 'thorough' }, t('depthThorough')),
                ], {
                  disabled: !writable || busy,
                  onChange: (event) => edit('depthBudget', event.target.value),
                }),
              ),
            ),
            h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } }, t('budgetStrategyHint')),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
              h('input', {
                type: 'checkbox',
                checked: draft.inspectEnabled !== false,
                disabled: !writable || busy,
                onChange: (event) => edit('inspectEnabled', event.target.checked),
              }),
              t('inspectEnabled'),
            ),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
              h('input', {
                type: 'checkbox',
                checked: draft.verifyWrites !== false,
                disabled: !writable || busy,
                onChange: (event) => edit('verifyWrites', event.target.checked),
              }),
              t('verifyWrites'),
            ),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
              h('input', {
                type: 'checkbox',
                checked: draft.fallbackToDirect !== false,
                disabled: !writable || busy,
                onChange: (event) => edit('fallbackToDirect', event.target.checked),
              }),
              t('fallback'),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12, paddingTop: 12, borderTop: '0.5px solid var(--dsw-alias-border-l2)' } },
            h(
              'button',
              {
                type: 'button',
                disabled: !writable || busy || !dirty,
                onClick: () => void save(),
                style: {
                  font: 'inherit',
                  fontSize: 13,
                  padding: '6px 14px',
                  borderRadius: 'var(--dsw-radius-md, 6px)',
                  border: '0.5px solid var(--dsw-alias-border-l4)',
                  background: dirty && writable ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                  color: dirty && writable ? '#fff' : 'var(--dsw-alias-label-primary)',
                  cursor: dirty && writable ? 'pointer' : 'default',
                },
              },
              busy ? t('saving') : t('save'),
            ),
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, notice !== '' ? notice : dirty ? t('unsaved') : ''),
            writable ? null : h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('readOnly')),
          ),
        ),
      );
    }

    const tabBarStyle = {
      display: 'flex',
      gap: 4,
      margin: '0 0 12px',
      padding: 0,
      borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
    };

    /** One tab button; the active one is marked by weight, colour, and a rule. */
    function tabButton(active, label, onClick) {
      return h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': active,
          onClick,
          style: {
            font: 'inherit',
            fontSize: 13,
            fontWeight: active ? 600 : 400,
            padding: '6px 12px',
            marginBottom: -1,
            border: 0,
            borderBottom: `2px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'transparent'}`,
            background: 'transparent',
            color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
            cursor: 'pointer',
          },
        },
        label,
      );
    }

    /**
     * README отрисован по подмножеству markdown, а не целиком.
     *
     * Показывать сырой текст нельзя, а markdown-рендера в этом бандле нет, и
     * новая зависимость ради одной вкладки — лишняя (см. docs/development.md).
     * Поэтому поддержаны ровно те конструкции, которые есть в README: заголовки
     * `#`..`###`, списки, ограждённые блоки, таблицы, инлайн-код, **жирный** и
     * ссылки. Неизвестная конструкция остаётся обычным абзацем — деградация
     * явная, не молчаливая.
     *
     * @param {object} props `{ markdown, t }`
     * @returns {object} дерево React
     */
    function ReadmePanel(props) {
      // Своего заголовка у панели нет: README начинается с собственного `#`
      // заголовка, а сверху хост уже показал название и описание строки.
      // Примечание про сборку — для автора плагина, не для читателя.
      return h(
        'section',
        { role: 'tabpanel', style: { display: 'grid', gap: 12 } },
        renderMarkdown(props.markdown),
      );
    }

    /** Inline code, bold spans, and links inside one line of text. */
    function inline(line, keyPrefix) {
      const nodes = [];
      const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
      let cursor = 0;
      let match = pattern.exec(line);
      let index = 0;
      while (match !== null) {
        if (match.index > cursor) nodes.push(line.slice(cursor, match.index));
        const key = `${keyPrefix}-${index}`;
        if (match[1] !== undefined) {
          nodes.push(
            h('code', { key, style: { fontSize: 12, padding: '1px 4px', borderRadius: 4, background: 'var(--dsw-alias-surface-l2, rgba(127,127,127,0.12))' } }, match[1]),
          );
        } else if (match[2] !== undefined) {
          nodes.push(h('strong', { key }, match[2]));
        } else {
          // README-ссылки относительные: файлов в web-бандле нет, поэтому ссылка
          // остаётся видимой, но не ведёт в несуществующий адрес GUI.
          nodes.push(h('span', { key, title: match[4], style: { textDecoration: 'underline dotted' } }, match[3]));
        }
        cursor = pattern.lastIndex;
        index += 1;
        match = pattern.exec(line);
      }
      if (cursor < line.length) nodes.push(line.slice(cursor));
      return nodes;
    }

    /** Split a table row into cells, dropping the leading and trailing pipes. */
    function cellsOf(row) {
      return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
    }

    /**
     * Renders the README subset.
     *
     * @param {string} markdown текст из встроенного блока README_MARKDOWN
     * @returns {Array<object>} блоки страницы
     */
    function renderMarkdown(markdown) {
      const lines = markdown.split('\n');
      const blocks = [];
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        const key = `line-${index}`;
        if (/^\s*```/.test(line)) {
          const body = [];
          index += 1;
          while (index < lines.length && !/^\s*```/.test(lines[index])) body.push(lines[index++]);
          index += 1;
          blocks.push(
            h(
              'pre',
              { key, style: { margin: 0, padding: '10px 12px', borderRadius: 6, overflowX: 'auto', background: 'var(--dsw-alias-surface-l2, rgba(127,127,127,0.12))', fontSize: 12, lineHeight: 1.5 } },
              h('code', null, body.join('\n')),
            ),
          );
          continue;
        }
        const heading = /^(#{1,3})\s+(.*)$/.exec(line);
        if (heading !== null) {
          const level = heading[1].length;
          blocks.push(
            h(
              level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4',
              { key, style: { margin: '8px 0 0', fontSize: level === 1 ? 15 : 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
              inline(heading[2], key),
            ),
          );
          index += 1;
          continue;
        }
        if (/^\s*\|/.test(line)) {
          const rows = [];
          while (index < lines.length && /^\s*\|/.test(lines[index])) rows.push(lines[index++]);
          const head = cellsOf(rows[0]);
          const body = rows.slice(rows[1] !== undefined && /^[\s|:-]+$/.test(rows[1]) ? 2 : 1);
          blocks.push(
            h(
              'table',
              { key, style: { borderCollapse: 'collapse', fontSize: 12, width: '100%' } },
              h('thead', null, h('tr', null, head.map((cell, cellIndex) => h('th', { key: cellIndex, style: { textAlign: 'left', padding: '4px 8px', borderBottom: '0.5px solid var(--dsw-alias-border-l4)' } }, inline(cell, `${key}-h${cellIndex}`))))),
              h(
                'tbody',
                null,
                body.map((row, rowIndex) =>
                  h('tr', { key: `${key}-r${rowIndex}` }, cellsOf(row).map((cell, cellIndex) => h('td', { key: cellIndex, style: { padding: '4px 8px', verticalAlign: 'top', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' } }, inline(cell, `${key}-${rowIndex}-${cellIndex}`)))),
                ),
              ),
            ),
          );
          continue;
        }
        if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
          const items = [];
          while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
          blocks.push(
            h(
              'ul',
              { key, style: { margin: 0, paddingLeft: 20, display: 'grid', gap: 4, fontSize: 13, lineHeight: 1.5 } },
              items.map((item, itemIndex) => h('li', { key: itemIndex }, inline(item, `${key}-i${itemIndex}`))),
            ),
          );
          continue;
        }
        if (line.trim() === '' || /^\s*---+\s*$/.test(line)) {
          index += 1;
          continue;
        }
        // Абзац: соседние непустые строки склеиваются, как и в исходном markdown.
        const paragraph = [];
        while (index < lines.length && lines[index].trim() !== '' && !/^\s*(#{1,3}\s|```|\||[-*]\s|\d+\.\s|---+\s*$)/.test(lines[index])) {
          paragraph.push(lines[index++].trim());
        }
        blocks.push(
          h('p', { key, style: { margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))' } }, inline(paragraph.join(' '), key)),
        );
      }
      return blocks;
    }

    /** Render a component error as visible text instead of blanking the slot. */
    class CardBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error !== null) {
          return h(
            'p',
            { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } },
            `delegate-io page error: ${String(this.state.error?.message ?? this.state.error)}`,
          );
        }
        return this.props.children;
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('delegateIo', { en, ru }), 'delegate-io: dictionaries');

        const scope = formScopeOf(ctx);
        ctx.effect(() => () => void scope?.dispose(), 'delegate-io: configuration form');

        // Remote namespaces must be injected before they can be read off the
        // context. Both faces stay optional: the form falls back to the shared
        // configuration form and to manual entry when they are absent.
        const hostStore = {
          current: undefined,
          listeners: new Set(),
          set(value) {
            this.current = value;
            for (const listener of [...this.listeners]) listener();
          },
          subscribe(listener) {
            this.listeners.add(listener);
            return () => this.listeners.delete(listener);
          },
        };
        ctx.inject(['remote', 'remote.session', 'remote.settings'], (child) => {
          hostStore.set({
            async load() {
              const response = await child.remote.session.modelCatalog();
              if (response === null || response === undefined || response.ok !== true) {
                throw new Error(response?.error?.message ?? 'model catalog is unavailable');
              }
              return catalogGroups(response.value);
            },
            async save(ops) {
              // Read the revision right before writing: the settings document
              // may have moved on since this form was rendered.
              const described = await child.remote.settings.describe();
              const row = described?.ok ? described.value.namespaces.find((entry) => entry.ns === NAMESPACE) : undefined;
              const response = await child.remote.settings.mutate(NAMESPACE, ops, row?.revision);
              if (response?.ok !== true) {
                const error = response?.error;
                return {
                  ok: false,
                  message: error === undefined ? 'settings write failed' : `${error.code}: ${error.message}`,
                };
              }
              // The write is on disk. The running row reloads through the
              // profile patch, so the values this client holds may still be the
              // pre-write ones: read the row back and let the form adopt what
              // the Host reports now.
              const after = await child.remote.settings.describe();
              const stored = after?.ok ? after.value.namespaces.find((entry) => entry.ns === NAMESPACE) : undefined;
              return stored === undefined ? { ok: true } : { ok: true, value: stored.value, revision: stored.revision };
            },
          });
          child.effect(() => () => hostStore.set(undefined), 'delegate-io: host faces');
        });

        const render = (props) => h(CardBoundary, null, h(Card, { ...props, ctx, scope, hostStore }));

        // The bundle page: the settings sit between the description and the
        // component rows, which is where users look for them.
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE_NAME, locale: 'delegateIo' }, render),
        );

        // The row's own page keeps the same form.
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY, locale: 'delegateIo' }, render),
        );
      },
    };
  },
});
