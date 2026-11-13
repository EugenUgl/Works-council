/**
 * Впечатывает markdown `README.md` в `client.js` — в блок между маркерами
 * `README-НАЧАЛО` и `README-КОНЕЦ`.
 *
 * Почему именно так. Сначала README лежал отдельным модулем `readme.js`, и
 * `client.js` делал `require('./readme.js')`. Это **уронило запуск DSH**:
 * загрузчик web-бандла резолвит только `react`, для любого другого запроса
 * пишет `require("<id>") missed the module table` и отказывает целиком —
 * приложение не стартует, потому что не стартовал один плагин (инцидент
 * 2026-11-13, см. docs/decisions.md → D19). Client-скрипт плагина обязан быть
 * самодостаточным файлом: никаких `require`, кроме платформенных.
 *
 * Второй заход — отдельный `.mjs`-модуль — тоже не годится: бандл собирается
 * из одного скрипта, и соседний файл в него не попадает. Остаётся встроить
 * текст прямо в исходник. Рукописная вставка разъехалась бы с `README.md`,
 * поэтому её делает генератор, а `npm test` падает, если блок устарел.
 *
 * Запуск:
 *   node scripts/build-readme.mjs          — обновить блок в client.js
 *   node scripts/build-readme.mjs --check  — только проверить свежесть
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README_PATH = join(ROOT, 'README.md');
const CLIENT_PATH = join(ROOT, 'client.js');

const BEGIN = '// README-НАЧАЛО';
const END = '// README-КОНЕЦ';

/**
 * Разделы README, которые не попадают на вкладку в GUI.
 *
 * Вкладка открыта **первой** и читается человеком, пришедшим настроить
 * плагин, а не собрать его. Разделы ниже описывают работу с репозиторием:
 * команды запуска тестов, дерево каталогов, правила для агента. В GUI они
 * ложны (запускать нечего) и превращают справку в гору текста, скроллить
 * которую пользователь не станет — то есть работают против самой идеи
 * вкладки.
 *
 * Убираем по заголовку раздела целиком, до следующего `## `.
 *
 * @param {string} markdown текст README.md
 * @returns {string} текст без разделов для разработчика
 */
function withoutDeveloperSections(markdown) {
	let text = markdown;
	// «Правило проекта» — отдельный блок с маркерами `──`, своего `##`-уровня.
	text = text.replace(/## ── Правило проекта ──[\s\S]*?\n---\n\n/, '');
	for (const heading of ['## Быстрый старт', '## Структура репозитория']) {
		// [\s\S]*? до следующего заголовка второго уровня или конца файла.
		const pattern = new RegExp(`${heading}[\\s\\S]*?(?=\\n## |$)`);
		text = text.replace(pattern, '');
	}
	// Пустые «швы» от вырезанных блоков: три и более переводов строки подряд.
	return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Экранирует то, что сломало бы template literal: README содержит обратные
 * кавычки и `${` в примерах кода.
 *
 * @param {string} text исходный markdown
 * @returns {string} markdown, безопасный внутри обратных кавычек
 */
function escapeTemplate(text) {
	return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Строки, которые встают на место блока между маркерами.
 *
 * @param {string} markdown текст README.md
 * @returns {string[]} объявление константы и её закрытие
 */
function blockLines(markdown) {
	return ['    const README_MARKDOWN = `', escapeTemplate(withoutDeveloperSections(markdown)), '    `;'];
}

/**
 * Находит в исходнике клиента строки между маркерами.
 *
 * Почему маркеры, а не «переписать файл целиком»: `client.js` — это весь
 * клиент плагина, и генератор не имеет права касаться остального его кода.
 * Маркерный блок — единственная зона, где он хозяин.
 *
 * @param {string} source содержимое client.js
 * @returns {{ start: number, end: number } | undefined} индексы строк маркеров
 */
export function markerRange(source) {
	const lines = source.split('\n');
	const start = lines.findIndex((line) => line.includes(BEGIN));
	const end = lines.findIndex((line) => line.includes(END));
	if (start < 0 || end < 0 || end < start) return undefined;
	return { start, end };
}

/**
 * Полный исходник `client.js` с актуальным текстом README.
 *
 * @param {string} source содержимое client.js
 * @param {string} markdown текст README.md
 * @returns {string} содержимое client.js, которое должно лежать на диске
 */
export function buildSource(source, markdown) {
	const range = markerRange(source);
	if (!range) {
		// Отказ с контекстом: без маркеров молчаливая замена задела бы чужой код
		// или не задела ничего, и вкладка показала бы старый текст.
		throw new Error(
			`client.js: не найдены маркеры "${BEGIN}" / "${END}" — встроить README некуда. ` +
				'Восстановите блок объявления README_MARKDOWN между ними.',
		);
	}
	const lines = source.split('\n');
	const next = [
		...lines.slice(0, range.start + 1),
		...blockLines(markdown),
		...lines.slice(range.end),
	];
	return next.join('\n');
}

/**
 * Читает README.md и client.js и собирает актуальный исходник клиента.
 *
 * @returns {Promise<string>} содержимое, которое должно лежать в client.js
 */
export async function currentSource() {
	const [markdown, source] = await Promise.all([
		readFile(README_PATH, 'utf8'),
		readFile(CLIENT_PATH, 'utf8'),
	]);
	return buildSource(source, markdown);
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === join(process.argv[1]);
if (invokedDirectly) {
	const source = await currentSource();
	const onDisk = await readFile(CLIENT_PATH, 'utf8');
	if (process.argv.includes('--check')) {
		if (onDisk !== source) {
			console.error('блок README в client.js устарел: запустите npm run build:readme.');
			process.exit(1);
		}
		console.log('блок README в client.js соответствует README.md');
	} else if (onDisk === source) {
		console.log('блок README в client.js уже актуален');
	} else {
		await writeFile(CLIENT_PATH, source, 'utf8');
		console.log('блок README в client.js обновлён');
	}
}
