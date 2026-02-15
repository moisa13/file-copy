# File Copy Manager — Especificação Técnica Completa

## 1. Visão Geral

Sistema de cópia gerenciada de arquivos com fila de processamento, dashboard web, logging estruturado e persistência. Desenvolvido em **Node.js**.

### Objetivo

Copiar arquivos de **N pastas de origem** para **1 pasta de destino**, com controle total sobre o processo: fila com status, acompanhamento em tempo real, logs por canal, persistência contra quedas e controle operacional (pausar, retomar, configurar workers).

---

## 2. Arquitetura

```
file-copy-manager/
├── src/
│   ├── index.js              # Entry point — inicializa tudo
│   ├── config.js             # Configurações centralizadas
│   ├── queue/
│   │   └── database.js       # Persistência com SQLite (better-sqlite3)
│   ├── scanner/
│   │   └── index.js          # Varredura recursiva das pastas de origem
│   ├── workers/
│   │   └── index.js          # Pool de workers para cópia paralela
│   ├── logger/
│   │   └── index.js          # Sistema de log multicanal com rotação
│   └── api/
│       └── index.js          # API REST + WebSocket (Express + ws)
├── public/
│   └── index.html            # Dashboard SPA (HTML/CSS/JS inline)
├── logs/                     # Diretório de logs (criado automaticamente)
├── data/                     # Banco SQLite (criado automaticamente)
└── package.json
```

### Dependências

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "better-sqlite3": "^9.4.3",
    "ws": "^8.16.0",
    "rotating-file-stream": "^3.1.1"
  }
}
```

- **express**: API REST para o dashboard
- **better-sqlite3**: Persistência da fila em SQLite (síncrono, sem overhead de ORM)
- **ws**: WebSocket para atualização em tempo real no dashboard
- **rotating-file-stream**: Rotação de logs por tamanho

---

## 3. Configuração (`src/config.js`)

```javascript
const path = require('path');

module.exports = {
  // N pastas de origem
  sourceFolders: [
    // '/caminho/pasta/origem1',
    // '/caminho/pasta/origem2',
  ],

  // 1 pasta de destino
  destinationFolder: '',
  // '/caminho/pasta/destino',

  // Workers paralelos
  workers: {
    count: 4,       // Padrão inicial
    maxCount: 16,   // Máximo permitido
  },

  // Logging
  logging: {
    directory: path.join(__dirname, '..', 'logs'),
    maxFileSize: '10M',   // Rotação a cada 10MB
    maxFiles: 50,         // Manter até 50 arquivos rotacionados
  },

  // Persistência SQLite
  database: {
    path: path.join(__dirname, '..', 'data', 'queue.db'),
  },

  // Dashboard
  server: {
    port: 3000,
    host: '0.0.0.0',
  },

  // Hash
  hashAlgorithm: 'sha256',

  // Scanner
  scanner: {
    recursive: true,
    ignorePatterns: ['.DS_Store', 'Thumbs.db', '.gitkeep'],
  },
};
```

---

## 4. Persistência — Banco de Dados (`src/queue/database.js`)

Usar **better-sqlite3** com modo WAL para performance e resistência a corrupção.

### Schema

```sql
CREATE TABLE IF NOT EXISTS file_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  source_folder TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  source_hash TEXT,
  destination_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  started_at TEXT,
  completed_at TEXT,
  worker_id INTEGER,
  UNIQUE(source_path, destination_path)
);

CREATE INDEX IF NOT EXISTS idx_status ON file_queue(status);
CREATE INDEX IF NOT EXISTS idx_source_folder ON file_queue(source_folder);

CREATE TABLE IF NOT EXISTS service_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
```

### Status possíveis

| Status | Descrição |
|--------|-----------|
| `pending` | Aguardando processamento |
| `in_progress` | Sendo copiado por um worker |
| `completed` | Cópia finalizada com sucesso |
| `error` | Falha na cópia (permissão, disco cheio, etc.) |
| `conflict` | Arquivo existe no destino com hash SHA-256 diferente |

### Recuperação após queda

Na inicialização do banco, **SEMPRE** executar:

```sql
UPDATE file_queue
SET status = 'pending', worker_id = NULL, started_at = NULL,
    updated_at = datetime('now', 'localtime')
WHERE status = 'in_progress';
```

Isso garante que arquivos que estavam "em andamento" durante um crash voltem para a fila automaticamente.

### Estado do serviço

Persistir na tabela `service_state`:
- `serviceStatus`: `'running'` | `'paused'` | `'stopped'`
- `workerCount`: número de workers ativos

Isso permite restaurar o estado operacional após reinício.

### Métodos necessários

- `addFiles(files)` — Inserção em batch com transaction
- `getNextPending(limit)` — Buscar próximos N pendentes
- `updateStatus(id, status, extras)` — Atualizar status com campos opcionais (hash, erro, workerId, timestamps)
- `getStats()` — Contagem e tamanho total por status
- `getFilesByStatus(status, limit, offset)` — Listagem paginada por status
- `getRecentActivity(limit)` — Últimas N atualizações
- `resolveConflict(id, action)` — `'overwrite'` volta para pending, `'skip'` marca como completed
- `resolveAllConflicts(action)` — Resolver todos os conflitos de uma vez
- `retryError(id)` / `retryAllErrors()` — Recolocar erros na fila
- `getServiceState(key)` / `setServiceState(key, value)` — Persistir estado do serviço

---

## 5. Scanner de Arquivos (`src/scanner/index.js`)

### Comportamento

1. Iterar sobre cada pasta em `config.sourceFolders`
2. Varredura **recursiva** (incluindo subpastas)
3. Ignorar arquivos que casem com `config.scanner.ignorePatterns`
4. Para cada arquivo encontrado, calcular o `relativePath` em relação à pasta de origem
5. O `destinationPath` = `config.destinationFolder` + `relativePath` (preservando a estrutura de subpastas)
6. Inserir todos os arquivos no banco com status `pending` (usar `INSERT OR IGNORE` para não duplicar)
7. Logar cada arquivo adicionado

### Dados coletados por arquivo

```javascript
{
  sourcePath: '/origem1/subpasta/arquivo.txt',     // Caminho absoluto de origem
  sourceFolder: '/origem1',                         // Pasta de origem base
  relativePath: 'subpasta/arquivo.txt',             // Caminho relativo
  destinationPath: '/destino/subpasta/arquivo.txt', // Caminho de destino
  fileSize: 1048576,                                // Tamanho em bytes (via fs.statSync)
}
```

---

## 6. Workers / Motor de Cópia (`src/workers/index.js`)

### Pool de Workers

Usar um EventEmitter que gerencia N workers lógicos (não threads reais — usar concorrência async com promises).

### Fluxo de cada worker

```
1. Buscar próximo arquivo "pending" no banco
2. Marcar como "in_progress" (com worker_id)
3. Verificar se o arquivo já existe no destino:
   a. Se NÃO existe → copiar
   b. Se existe:
      - Calcular hash SHA-256 da origem
      - Calcular hash SHA-256 do destino
      - Se hashes iguais → marcar como "completed" (já está lá, idêntico)
      - Se hashes diferentes → marcar como "conflict" (aguardar decisão manual)
4. Executar a cópia:
   - Criar diretórios intermediários no destino (fs.mkdirSync recursive)
   - Copiar usando streams (fs.createReadStream → fs.createWriteStream)
   - Calcular hash SHA-256 durante a leitura do stream (crypto.createHash)
5. Após cópia, verificar integridade:
   - Calcular hash do arquivo copiado
   - Comparar com hash da origem
   - Se igual → marcar como "completed"
   - Se diferente → marcar como "error" (falha de integridade)
6. Em caso de exceção → marcar como "error" com mensagem
7. Logar toda transição de status
8. Emitir evento para o WebSocket atualizar o dashboard
```

### Cópia com stream e hash simultâneo

```javascript
async function copyFileWithHash(sourcePath, destinationPath) {
  const dir = path.dirname(destinationPath);
  fs.mkdirSync(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const readStream = fs.createReadStream(sourcePath);
    const writeStream = fs.createWriteStream(destinationPath);

    readStream.on('data', (chunk) => hash.update(chunk));
    readStream.pipe(writeStream);

    writeStream.on('finish', () => resolve(hash.digest('hex')));
    writeStream.on('error', reject);
    readStream.on('error', reject);
  });
}
```

### Cálculo de hash de arquivo existente

```javascript
async function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
```

### Controles

- `start()` — Inicia o processamento
- `pause()` — Para de puxar novos arquivos (workers ativos terminam o arquivo atual)
- `resume()` — Retoma o processamento
- `stop()` — Para tudo
- `setWorkerCount(n)` — Altera número de workers (mínimo 1, máximo `config.workers.maxCount`)

### Loop de processamento

Usar um loop com `setTimeout` para não bloquear o event loop:

```
_processLoop():
  - Se pausado ou parado → retornar
  - Calcular slots disponíveis = workerCount - activeWorkers
  - Se slots > 0 → buscar N pendentes do banco → processar cada um em paralelo
  - Agendar próximo check em 200ms
```

---

## 7. Sistema de Logging (`src/logger/index.js`)

### Canais de log

| Canal | Arquivo | Conteúdo |
|-------|---------|----------|
| `geral` | `geral.log` | Todas as operações |
| `pendente` | `pendente.log` | Arquivos adicionados à fila |
| `em_andamento` | `em_andamento.log` | Início de cópia |
| `erro` | `erro.log` | Falhas de cópia |
| `conflito` | `conflito.log` | Conflitos detectados |
| `finalizado` | `finalizado.log` | Cópias concluídas |

### Formato de cada entrada

```
[2026-02-13T14:30:00.000Z] [STATUS] [Worker:2] Arquivo: /origem/doc.pdf | Origem: /origem | Tamanho: 15.20 MB | Hash: abc123... | Mensagem adicional
```

### Campos obrigatórios

- **Timestamp**: ISO 8601
- **Status**: PENDING, IN_PROGRESS, COMPLETED, ERROR, CONFLICT
- **Worker ID**: Qual worker processou
- **Arquivo**: Caminho completo de origem
- **Pasta de origem**: Pasta base
- **Tamanho**: Formatado (ex: "15.20 MB") + valor em bytes
- **Hash**: SHA-256 (quando disponível)
- **Mensagem de erro**: Quando aplicável

### Rotação

Usar `rotating-file-stream` com rotação por tamanho (`10M`). Nomenclatura rotacionada: `{canal}-{data}-{indice}.log`.

### Regra de escrita

Toda entrada é escrita em **dois canais simultaneamente**:
1. Canal **geral** (sempre)
2. Canal **específico do status** (sempre)

---

## 8. API REST (`src/api/index.js`)

Usar **Express** para a API e **ws** para WebSocket.

### Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/stats` | Estatísticas gerais (contadores por status) |
| `GET` | `/api/files/:status` | Listar arquivos por status (query: `?limit=100&offset=0`) |
| `GET` | `/api/activity` | Últimas 50 atualizações |
| `GET` | `/api/service` | Estado do serviço (status, workers) |
| `POST` | `/api/service/start` | Iniciar processamento |
| `POST` | `/api/service/pause` | Pausar processamento |
| `POST` | `/api/service/resume` | Retomar processamento |
| `POST` | `/api/service/stop` | Parar processamento |
| `POST` | `/api/service/workers` | Alterar nº de workers (body: `{ "count": 8 }`) |
| `POST` | `/api/scan` | Executar nova varredura das pastas de origem |
| `POST` | `/api/conflicts/:id/resolve` | Resolver conflito individual (body: `{ "action": "overwrite" \| "skip" }`) |
| `POST` | `/api/conflicts/resolve-all` | Resolver todos os conflitos (body: `{ "action": "overwrite" \| "skip" }`) |
| `POST` | `/api/errors/:id/retry` | Retentar cópia de um arquivo com erro |
| `POST` | `/api/errors/retry-all` | Retentar todos os erros |

### WebSocket

Endpoint: `ws://host:port` (upgrade no mesmo servidor HTTP)

O servidor emite eventos JSON para todos os clientes conectados:

```json
{
  "event": "status-update",
  "data": {
    "fileId": 123,
    "status": "completed",
    "sourcePath": "/origem/arquivo.txt",
    "timestamp": "2026-02-13T14:30:00.000Z"
  }
}
```

```json
{
  "event": "stats-update",
  "data": {
    "pending": { "count": 45, "totalSize": 1073741824 },
    "in_progress": { "count": 4, "totalSize": 52428800 },
    "completed": { "count": 150, "totalSize": 5368709120 },
    "error": { "count": 2, "totalSize": 2097152 },
    "conflict": { "count": 3, "totalSize": 15728640 }
  }
}
```

```json
{
  "event": "service-update",
  "data": {
    "status": "running",
    "workerCount": 4,
    "activeWorkers": 3
  }
}
```

Emitir `stats-update` a cada transição de status de arquivo e periodicamente (a cada 2 segundos).

---

## 9. Dashboard Web (`public/index.html`)

Arquivo HTML único (SPA) com CSS e JS inline. **Sem autenticação.** Sem frameworks — vanilla JS.

### Layout do Dashboard

```
┌──────────────────────────────────────────────────────────┐
│  FILE COPY MANAGER                          [Status: ●]  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Pendentes│ │Em Andam. │ │  Erros   │ │Conflitos │   │
│  │   45     │ │    4     │ │    2     │ │    3     │   │
│  │ 1.0 GB   │ │ 50 MB    │ │ 2 MB     │ │ 15 MB    │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │
│                                                          │
│  ┌──────────┐                                           │
│  │Finalizad.│   Progresso Total: ████████░░ 73.5%       │
│  │  150     │                                           │
│  │ 5.0 GB   │                                           │
│  └──────────┘                                           │
│                                                          │
├──── CONTROLES ──────────────────────────────────────────┤
│                                                          │
│  [▶ Iniciar] [⏸ Pausar] [⏹ Parar] [🔄 Re-escanear]    │
│                                                          │
│  Workers: [  4  ] [Aplicar]                              │
│                                                          │
│  Conflitos: [Sobrescrever Todos] [Pular Todos]           │
│  Erros:     [Retentar Todos]                             │
│                                                          │
├──── TABELA DE ARQUIVOS ─────────────────────────────────┤
│                                                          │
│  Filtro: [Todos ▼] [Pendentes] [Em And.] [Erros]        │
│          [Conflitos] [Finalizados]                       │
│                                                          │
│  ┌────┬─────────────────┬──────────┬────────┬─────────┐ │
│  │ ID │ Arquivo          │ Origem   │Tamanho │ Status  │ │
│  ├────┼─────────────────┼──────────┼────────┼─────────┤ │
│  │ 1  │ doc.pdf          │ /orig1   │ 15 MB  │ ✅ OK   │ │
│  │ 2  │ foto.jpg         │ /orig2   │ 3 MB   │ ⚠ Conf. │ │
│  │ 3  │ data.csv         │ /orig1   │ 500 KB │ ❌ Erro │ │
│  └────┴─────────────────┴──────────┴────────┴─────────┘ │
│                                                          │
│  Na linha de conflito: botões [Sobrescrever] [Pular]     │
│  Na linha de erro: botão [Retentar]                      │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Funcionalidades do Dashboard

1. **Cards de status**: Contadores com totais em tamanho por status, atualizados via WebSocket
2. **Barra de progresso geral**: `(completed / total) * 100`
3. **Controles do serviço**: Botões para iniciar, pausar, retomar, parar
4. **Configuração de workers**: Input numérico + botão aplicar
5. **Resolução em massa**: Botões para resolver todos os conflitos ou retentar todos os erros
6. **Tabela de arquivos**: Filtrável por status, com ações inline (resolver conflito, retentar erro)
7. **Indicador de conexão WebSocket**: Mostrar se está conectado ao servidor
8. **Auto-reconnect WebSocket**: Reconectar automaticamente se a conexão cair

### Estilo visual

- Design escuro (dark theme) com cores distintas por status:
  - Pendente: azul (`#3b82f6`)
  - Em Andamento: amarelo (`#f59e0b`)
  - Finalizado: verde (`#10b981`)
  - Erro: vermelho (`#ef4444`)
  - Conflito: laranja (`#f97316`)
- Tipografia limpa e legível, fonte monospace para dados
- Layout responsivo

---

## 10. Entry Point (`src/index.js`)

### Fluxo de inicialização

```
1. Carregar config
2. Validar configurações (pastas existem, destino é gravável)
3. Inicializar banco de dados (SQLite) → recuperação automática de crash
4. Inicializar logger
5. Restaurar estado do serviço (workerCount salvo, etc.)
6. Executar varredura inicial das pastas de origem
7. Inicializar servidor Express + WebSocket
8. Servir dashboard em GET /
9. Registrar rotas da API
10. Iniciar pool de workers (se estado anterior era 'running')
11. Logar início do sistema
12. Tratar SIGINT/SIGTERM para shutdown graceful
```

### Shutdown graceful

Ao receber SIGINT ou SIGTERM:
1. Parar de aceitar novos arquivos
2. Aguardar workers ativos finalizarem o arquivo atual
3. Salvar estado no banco
4. Fechar streams de log
5. Fechar banco de dados
6. Encerrar processo

---

## 11. Regras de Negócio Importantes

### Conflitos

- Um conflito é detectado quando: o arquivo **já existe no destino** E o hash SHA-256 do arquivo de origem é **diferente** do hash do arquivo no destino
- Se o hash for **igual**: marcar como `completed` sem copiar (o arquivo já está lá, idêntico)
- Conflitos ficam **parados na fila** até decisão manual via dashboard
- Ações possíveis: `overwrite` (sobrescrever — volta para `pending` e será copiado) ou `skip` (pular — marca como `completed`)

### Estrutura de diretórios no destino

- Manter a mesma estrutura de subpastas da origem
- Se a origem é `/orig1/subpasta/arquivo.txt`, o destino deve ser `/destino/subpasta/arquivo.txt`
- Criar diretórios intermediários automaticamente com `fs.mkdirSync(dir, { recursive: true })`

### Integridade pós-cópia

- Após copiar, calcular hash do arquivo no destino
- Comparar com hash da origem
- Se diferente → marcar como `error` com mensagem "Falha de integridade: hash pós-cópia não confere"

### Deduplicação

- `UNIQUE(source_path, destination_path)` no banco impede que o mesmo arquivo seja enfileirado duas vezes
- Novas varreduras (`POST /api/scan`) apenas adicionam arquivos novos, não duplicam os existentes

---

## 12. Resumo dos Comandos para Setup

```bash
# Criar o projeto
mkdir file-copy-manager && cd file-copy-manager
npm init -y
npm install express better-sqlite3 ws rotating-file-stream

# Criar estrutura
mkdir -p src/{queue,scanner,workers,logger,api} public logs data

# Após implementar tudo:
node src/index.js
# Dashboard disponível em http://localhost:3000
```

---

## 13. Checklist de Implementação

- [ ] `package.json` com dependências
- [ ] `src/config.js` — Configurações centralizadas
- [ ] `src/queue/database.js` — SQLite com schema, CRUD, recuperação de crash
- [ ] `src/scanner/index.js` — Varredura recursiva + enfileiramento
- [ ] `src/workers/index.js` — Pool de workers async com cópia+hash via streams
- [ ] `src/logger/index.js` — 6 canais de log com rotação por tamanho
- [ ] `src/api/index.js` — Express REST + WebSocket
- [ ] `public/index.html` — Dashboard SPA completo
- [ ] `src/index.js` — Entry point com inicialização e shutdown graceful
- [ ] Testar recuperação após kill -9
- [ ] Testar conflitos (copiar arquivo, modificar destino, re-escanear)
- [ ] Testar alteração de workers em tempo real
- [ ] Testar pausar/retomar
