# История исследования (OpenVSCode Server)

## 2025‑10‑24

### 1. Исправление падения Extension Host при открытии представления Extensions
- Симптом: при `Ctrl+Shift+X` в браузерных логах — `Uncaught TypeError: i.hasAttribute is not a function`, Extensions view зависал на бесконечной загрузке, Extension Host попадал в состояние `unhandledRejection Canceled`.
- Что происходило: в `mouseTarget.ts::_findAttribute` предполагалось, что DOM-элементы имеют метод `hasAttribute`. Некоторые элементы переопределяли поле и приводили к вызову не-функции. Ошибка ломала обработку команд в webview.
- Исправление:
  - В `src/vs/editor/browser/controller/mouseTarget.ts` проверяется, что `hasAttribute` — функция. Если нет, выводится предупреждение, и поиск продолжается по DOM.
  - Сразу пропатчен собранный `workbench.js`, чтобы изменения применились без пересборки.

### 2. Текущий статус багов
- JS/Webview-ошибки из-за `hasAttribute` устранены.
- Остались проблемы:
  - Запрос галереи Open VSX `https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest` иногда возвращает ошибку; fallback `https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest` (тот же URL) ничего не даёт.
  - Webview assets (`index-*.css/js`) запрашиваются через `https://vscode-remote+<ip>.vscode-resource.vscode-cdn.net/...`, что в локальном режиме приводит к `ERR_NAME_NOT_RESOLVED`. Надо перенастроить `extensionResourceLoaderService`/`webview` на локальный сервер.

### 3. Планируемые задачи
- **Поддержка нескольких маркетплейсов**
  - Добавить конфигурацию для списка marketplaces (Open VSX + Visual Studio Marketplace).
  - Расширить `AbstractExtensionGalleryService` и `ExtensionGalleryManifestService`, чтобы подтягивать манифесты из обоих источников, корректно объединять результаты и использовать fallback.
  - Проверить совместимость API (VS Marketplace требует POST `/extensionquery` с другой схемой, не `/latest`).
  - Добавить в `product.json` описание дополнительного marketplace (serviceUrl/itemUrl/resourceUrlTemplate/extensionUrlTemplate).

- **Webview resources**
  - Разобраться, почему генерируется домен `vscode-remote+...vscode-resource.vscode-cdn.net` и перенаправить на локальный `https://<host>/oss-.../static/...`.
  - Проверить настройки `webviewContentExternalBaseUrlTemplate`, `extensionResourceLoaderService`, `webviewServiceWorker`.
  - Убедиться, что локальные ресурсы доступны без внешнего CDN и webview загружается корректно.

### 4. Промежуточный статус (2025‑10‑24 22:20)
- Обновил типы `IExtensionGalleryManifestService` и все потребители (workbench, IPC, node service), чтобы работать с множеством маркетплейсов через `IExtensionGalleryCompositeManifest`.
- `AbstractExtensionGalleryService` теперь перебирает доступные маркетплейсы, выполняет fallback и передаёт в остальной код данные по каждому маркету.
- UI (виджеты, вкладки, действия) и менеджмент расширений используют `getPrimaryExtensionGalleryMarketplace`, сохраняя старое поведение для первого маркетплейса.
- Добавлены CLI-параметры `--proxy-host/--proxy-port` в `ServerParsedArgs`, чтобы типы соответствовали новому коду в `webClientServer.ts`.

Все действия выполнялись в окружении: `/home/dev/public/openvscode-server` (код), `/home/openvscode-server` (runtime). `scai` использовался для управления headless Chrome.

## 2025‑10‑25

### 1. Актуализация multi-marketplace интерфейсов
- Продолжил вычищать упоминания старого `IExtensionGalleryManifest`: сервисы и UI теперь везде работают с `IExtensionGalleryCompositeManifest`.
- Упростил доступ к capability-спискам маркетов (фильтры, сортировки, флаги) и починил подписки на обновление манифеста в `extensionResourceLoader`.

### 2. Восстановление окружения сборки
- Локально отсутствовали `node_modules`, поэтому вручную подтянул пакеты из `/home/github-runner/_work/openvscode-server/openvscode-server` (без `npm install`/`rsync`): `ternary-stream`, `esbuild`, `@esbuild/*`, `typescript`, а также `node_modules` для `extensions/markdown-language-features`, `extensions/simple-browser`, `extensions/markdown-math`.
- После этого `npm run compile` проходит стадию esbuild, но `tsc` рушится из-за отсутствия глобальных типов (`Array`, `Record`, `Thenable` и пр.). `typescript/lib` присутствует — решать нужно восстановлением остальных @types и зависимостей (в частности из `build/node_modules`).

### 3. Дальнейшие шаги
- Допротянуть `build/node_modules` и extension-специфичные зависимости с раннера, чтобы `tsc` увидел типы (DebugProtocol и т.д.) и сборка пошла до конца.
- Вернуться к диагностике web‑runtime (404 на websocket + CORS) через `scai`, когда compile перестанет валиться на зависимостях.

### Дополнения (04:10)
- Подтянул оставшиеся @types из раннера (`node_modules/@types` целиком), но `npm run compile` всё ещё падает: TypeScript не видит базовые lib-типы (`Array`, `Record`, `PromiseLike`) внутри `src/vscode-dts/vscode.d.ts` и namespace `DebugProtocol`.
- Вернул конфиг `src/tsconfig.json` к состоянию с раннера (включая wildcard `./vscode-dts/vscode.proposed.*.d.ts`), переподключил кастомные `typings` через include. Ошибка не ушла — вероятно, ещё не хватает каких-то дистрибутивных пакетов (`build/node_modules` или собственных d.ts, которые gulp подмешивает на CI).
- Следующий шаг: точечно вытащить из `/home/github-runner/_work/openvscode-server/openvscode-server/build/node_modules` те пакеты, что отвечают за типы VS Code (`vscode-dts`, `vscode-debugprotocol`, возможные скрипты генерации), и повторить compile. После успешной сборки можно переходить к отладке runtime через `scai`.

### Промежуточный результат сборки (07:10)
- Полностью перенёс `node_modules`, `build/node_modules`, `remote/node_modules` из `/home/github-runner/_work/...` (через `tar -chf --dereference`) и вернул их на место. Бэкапы старых каталогов удалены.
- `tsconfig.json` дополнил явным списком файлов из `src/typings`, которые раньше не попадали в проект (иначе `LanguageServiceHost` игнорировал новые `.d.ts`).
- Сборка всё ещё валится на 96 ошибках: TypeScript 6 продолжает ругаться, что в `vscode.d.ts` отсутствуют базовые типы (`Array`, `Record`, `AsyncIterable`). Дополнительно появляются ошибки из-за наших деклараций `Timeout` (`Property '_' is missing ...`).
- По `ts.parseJsonConfigFileContent` видно, что компилятор видит библиотеки (`lib.es5.d.ts`, `lib.es2024.d.ts` и т.д.), но при анализе `vscode.d.ts` они не подхватываются. Надо дальше разбираться, почему `ts.createProgram` отдаёт diagnostics о базовых типах (возможно, бага TypeScript nightly, либо нужно подмешивать ещё один lib-пакет).
- План: экспериментально сузить список `lib` (например, подложить `lib.es2024.full.d.ts` вручную), проверить поведение на runner'е и, если потребуется, добавить shim для `Timeout` (чтобы не конфликтовал с DOM-определениями).

## 2025‑10‑26

### 1. TypeScript: восстановление стандартных типов
- Удалил временные алиасы `globalThis.*` из `src/vscode-dts/vscode.d.ts` и подключил нужные стандартные библиотеки через `/// <reference lib="es2024" />` и `es2018.asynciterable`. 
- Дополнительно перетащил `@types/node` и описал `TextEncoder`/`TextDecoder` в `extensions/types/lib.textEncoder.d.ts`, чтобы не требовать node-таски.
- `npm run compile` теперь доходит до TypeScript стадии и падает только по нехватке памяти (`FATAL ERROR: Ineffective mark-compacts...`). Диагностики "Cannot find name 'Array' / 'Record' / ..." ушли.

### 2. Браузерный рантайм
- Через `scai` воспроизвёл 404 на `wss://…/oss-<commit>?…`. Проблема оказалась в пути: WebSocket клиента формировал URL без завершающего `/`, и Apache отдавал 404 до проксирования.
- Исправление в `BrowserSocketFactory`: перед сборкой URL принудительно добавляю хвостовой `/` (`normalizedPath`), поэтому клиент теперь запрашивает `wss://…/oss-<commit>/?…`.
- Несмотря на это, прокси по-прежнему отвечал 404/200 вместо апгрейда — WebSocket не проходил, соединение завершалось `CodeExpectedError 1006`.
- 25.10: вернул в `/etc/apache2/sites-available/vsai-ssl.conf` старые `RewriteRule`-ы для Upgrade=websocket; после `systemctl reload apache2` ябранные `wss://`‑пробы и боевой клиент успешно проходят handshake (ошибка 1006 исчезла).

### 3. Прочее
- Зафиксировал требование отвечать пользователю на русском в `../devops/AGENTS.md`.

### 4. Ожидание готовности backend перед запуском workbench (26.10)
- Добавил промежуточный загрузчик `startup-gateway.js`, который через `/version` опрашивает readiness backend и только после успешного ответа динамически подключает `workbench.js`.
- Скрипт подцепляется в `workbench.html` вместо прямой загрузки workbench и переиспользует существующую переменную `_VSCODE_FILE_ROOT` для вычисления путей; после N попыток логирует текущее состояние в консоль (видно через `scai logs read`).
- Обновлён рантайм (`/home/openvscode-server/static/out/...`) и боевой билд (`/home/openvscode-server/out/...`), чтобы проверка выполнялась и для локального сервиса.
- В результате при рестарте `openvscode-server` фронтенд больше не делает ранние попытки WebSocket соединения с 503 — workbench стартует только после того, как `/version` начинает отвечать 200.

### 5. Extensions CI: ограничение параллельной упаковки (26.10)
- `npm run gulp extensions-ci` падал с OOM (exit 137) на шаге bundling non-native extensions. Причина — одновременный запуск webpack для ~30 расширений.
- В `build/lib/extensions.ts` добавил вспомогательную `mergeStreamsWithConcurrencyLimit`: потоки упаковки теперь запускаются партиями (по умолчанию 4). Значение настраивается переменной `VSCODE_EXTENSIONS_PACKAGER_CONCURRENCY` (или старой `VSCODE_EXTENSIONS_WEBPACK_CONCURRENCY` для обратной совместимости).
- JS-бандлы (`build/lib/extensions.js`) синхронизированы. При необходимости можно поднять/опустить параллелизм (например, `export VSCODE_EXTENSIONS_PACKAGER_CONCURRENCY=2`) перед вызовом `npm run gulp extensions-ci`.

### 6. Отказоустойчивый vsda (27.10)
- В веб-клиенте запрашивались `static/node_modules/vsda/rust/web/vsda.js` и `vsda_bg.wasm`, приводя к 404, поскольку пакет `vsda` не поставляется с OpenVSCode.
- Добавил stub-модуль в `out/node_modules/vsda/…`, который экспортирует "пустой" валидатор/сигнер и не пытается подгружать wasm. Бандл подтягивает его и просто логирует `ok`, без сетевых запросов и ошибок в консоли.

### 7. Extension Host завершается из-за устаревшего parentPid (26.10)
- В логах `/home/openvscode-server/.openvscode-server/data/logs/.../remoteagent.log` видно, что процесс EH стартует, а спустя ~1.2 с пишет `Extension host terminating: parent process 1126287 does not exist anymore: kill ESRCH` и выходит с кодом `0`.
- Браузер кэширует `IRemoteExtensionHostInitData` и повторно шлёт `parentPid` прошлой сессии. После рестарта backend получает новый PID (`process.pid` сервера), но клиент продолжает присылать старое значение — проверка `process.kill(parentPid, 0)` мгновенно ловит `ESRCH`, и EH завершает работу.
- В `src/vs/server/node/extensionHostConnection.ts` добавлен санитайзер начального JSON: перед передачей сокета мы заменяем `parentPid` на текущее `process.pid` и логируем корректировку. Аналогичный patch сделан в `out/vs/server/node/extensionHostConnection.js`.
- Патч применён и в минифицированном рантайме (`/home/openvscode-server/out/server-main.js`) + смежное дополнение в `/home/openvscode-server/out/vs/workbench/api/node/extensionHostProcess.js`, чтобы EH сравнивал `initData.parentPid` с `process.ppid`. Журналы `journalctl -u openvscode-server --since '13:10'` фиксируют `extHosts=…:alive` — после ребута EH больше не отваливается сразу после IPC handshake.
