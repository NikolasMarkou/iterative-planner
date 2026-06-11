# Python / Software-Engineering Caveat

**CONDITIONAL reference.** Consult this file ONLY when the plan is a Python or general software-engineering task (coding, architecture, refactoring, system design). For any non-software plan it does not apply — the planner core stays domain-neutral. It deliberately does NOT restate mental models the planner already owns and enforces; those appear here as cross-reference pointers only (see "Already covered elsewhere" below). What follows is the net-new software-design knowledge the planner core lacks.

## A. Software-design models (any language)

Compact mental models for software design, language-agnostic. Use them in EXPLORE (frame the problem), PLAN (justify a structure), and REFLECT (catch an anti-pattern). Each entry: definition + when to use it / implication.

### Already covered elsewhere — do not restate

These four concepts are OWNED by the planner core. Do not re-explain them in a plan or in this file — point to the source of truth:

| Concept | Source of truth (do not restate) |
|---|---|
| Kleppmann "X at the cost of Y" trade-off framing | `SKILL.md` (Trade-off rule + PC-PIVOT) — ENFORCED by `scripts/validate-plan.mjs` |
| Brooks essential vs accidental complexity; rule-of-three / earned-abstraction; Forbidden Fix Patterns | `references/complexity-control.md` |
| Hohpe hard / soft / ghost constraint taxonomy | `references/planning-rigor.md` (Ghost Constraint Hunting) |

If a model below would lead you to restate any of these, stop and write a `see references/...` pointer instead.

### Complexity & design

**Hickey — Simple ≠ Easy.** *Simple* = un-braided (one role/concept, objective). *Easy* = familiar/at-hand (subjective). Orthogonal: code can be simple-but-hard or easy-but-complex. For any construct ask "what does it braid (complect) together?" Prefer the simpler alternative even when it is less familiar.

| Construct | Complects → | Simpler alternative |
|---|---|---|
| State / objects | identity + value + time | Values (immutable, frozen dataclasses) |
| Variables | value + time | Managed references |
| Inheritance | types | Maps, protocols / polymorphism |
| Switch / match | who + what (closed) | Polymorphism, pattern dispatch |
| ORM | in-memory + on-disk | Declarative data manipulation |
| Imperative loops | what + how | Set functions, reduce, iterators |

*Use it when*: a thing is hard to change in isolation — find the braid and cut it. Simplicity is a choice that requires work; no amount of testing compensates for complected code.

**Ousterhout — Deep Modules.** Module value = functionality depth ÷ interface width. A *deep* module hides large complexity behind a narrow interface (gold standard: Unix file I/O — 5 calls hiding buffering, caching, drivers, locking). A long method with a simple signature is fine — it is deep. "Classitis" (many tiny shallow classes) increases complexity by spreading logic across complex interactions.
*Use it when*: choosing where to draw a boundary — make the interface much smaller than the implementation.

**Ousterhout — Red Flags.** Stop and reconsider when you see:

- **Shallow module** — interface as complex as implementation.
- **Information leakage** — two modules share knowledge of one design decision.
- **Temporal decomposition** — structure follows execution order (`step1_load`, `step2_save`) not knowledge.
- **Pass-through method** — delegates without adding value (why does the wrapper exist?).
- **Vague names / hard-to-describe interface** — if you can't explain it simply, it's too complex.

*Use it when*: reviewing a design or diff. Social rule: "if a reviewer says it's not obvious, don't argue" — the code is the problem.

**Ousterhout — Design It Twice.** Always generate ≥2 alternative designs before committing. The act of producing a second forces you to articulate what you optimize for, exposes hidden assumptions, and often yields a better synthesis. Cheap insurance against anchoring on the first workable idea.
*Use it when*: any decision that is hard to reverse. (See also `references/complexity-control.md` Simplification Check "Could I delete code instead?")

**Beck — Four Rules of Simple Design** (priority order): 1) passes the tests; 2) reveals intention (reader sees WHY); 3) no duplication; 4) fewest elements. When 2 and 3 conflict, **readability wins** over the technical metric.
*Use it when*: ranking competing implementations — apply the rules top-down.

**Fowler — Design Stamina Hypothesis.** Design quality is an economic investment, not aesthetics. Good design starts slightly slower but the cumulative-functionality curves cross within *weeks*; after the crossover, good design ships faster and the gap widens. Right question: "Can we afford NOT to invest in design?" (No, unless the project's shelf life is < 2 weeks.) Corollary — *sacrificial architecture*: design for ~10x growth, plan to replace before ~100x.
*Use it when*: tempted to skip design "to save time."

### Decision frameworks

**McKinley — Innovation Tokens.** Every org gets ~3 innovation tokens; each novel/immature/unfamiliar tech choice spends one. Boring tech wins: well-understood failure modes, no unknown unknowns, lower daily ops burden. Spend a token only when the problem genuinely can't be solved with boring tools AND you can write down why.
*Use it when*: proposing any new framework, datastore, or language — count the tokens already spent.

**Muratori — Performance vs Readability.** The gap between clean polymorphic code and hardware-aware code spans 1-2 orders of magnitude, but most code is not on a hot path. Decide deliberately: profile (don't guess) → if not hot, optimize for readability; if hot AND it matters for the product, write performance-oriented code for that path only.
*Use it when*: someone wants to "optimize" — demand a profile first.

**Monolith vs Microservices.** Default to a monolith with strong module boundaries. Microservices solve an *organizational* problem (teams stepping on each other), not a messy-codebase problem (they amplify mess). Extract a service only when domain boundaries are empirically stable and the org can deploy/own/operate it independently. **Distributed-monolith trap**: if services deploy together, share a DB, or need synchronized changes, you have all the coupling plus network unreliability — strictly worse than a monolith.
*Use it when*: anyone proposes splitting a service.

**Consistency vs Availability.** Don't argue "CAP." Specify the *consistency model* per subsystem: linearizable / sequential / causal / read-your-writes / eventual. Prioritize consistency where inconsistency is costly (money, inventory at checkout, auth, billing); prioritize availability where it's cheap (feeds, dashboards, search ranking, notification counts). Common split: write path strong, read path eventual.
*Use it when*: designing data flow — name the model, not the letter.

**Sync vs Async.** Heuristic: request/response where a user waits → sync (with timeouts + circuit breakers); fire-and-forget, cross-service propagation, fan-out, long-running → async (events/queues). Async buys time-decoupling and load absorption at the cost of ordering, idempotence, eventual consistency, and harder debugging. Rule of thumb: **I/O-bound waiting → async; CPU-bound work → processes/parallelism**, not async.
*Use it when*: choosing a call style between components.

**Build vs Buy** (4 questions): 1) core to competitive advantage? yes → build. 2) does a boring well-understood solution exist? yes → use it. 3) can you articulate IN WRITING why the existing stack can't solve this? no → you don't understand the problem yet, stop. 4) total cost of ownership? (build = dev + maintenance + on-call + hiring; buy = license + integration + lock-in + gaps) — buying is often cheaper than the sticker price suggests.
*Use it when*: evaluating a third-party dependency vs in-house code.

**Caching.** Cache when reads dominate (read:write > 10:1), computation is expensive and rarely-changing, or the upstream is fragile. Do NOT cache write-heavy data, fast-changing data, or anything that tolerates zero staleness (financial, auth). Pick the invalidation strategy explicitly: TTL (good default, bounded staleness), write-through (consistent, slower writes), write-behind (fast writes, loss risk), event-driven (precise, complex).
*Use it when*: latency pressure tempts a cache — decide invalidation first, not last.

**Database selection.** Default to PostgreSQL — it covers far more than people expect, and spending an innovation token on a DB is one of the most expensive choices. Deviate only with an articulable reason: document (Mongo/Dynamo) for hierarchical data accessed by key; wide-column (Cassandra) for enormous write volume by known partition key; graph (Neo4j) when relationships ARE the data.
*Use it when*: a non-Postgres DB is proposed — require the articulable reason.

### Data, code, & boundaries

**Pike — Data Dominates.** "If you've chosen the right data structures and organized things well, the algorithms will almost always be self-evident." Data structures are the skeleton; algorithms are the muscle.
*Use it when*: stuck on a gnarly algorithm — redesign the data representation first; the algorithm usually becomes obvious (often turning O(n²) into O(n)).

**Torvalds — Good Taste.** Rewrite the problem so a special case *becomes* the normal case. Make the happy path the only path; eliminate edge cases through a better data structure/abstraction, not more `if`-statements (his linked-list "pointer to pointer" removes the head-deletion special case).
*Use it when*: you catch yourself adding special-case handling — step back and look for the abstraction that deletes the case.

**Evans — Bounded Contexts (DDD).** A model is valid only within its context; the same term ("Customer") legitimately means different things in Billing vs Support vs Marketing — they share only an ID. A universal model becomes an unmaintainable God Object. **Anti-corruption layer**: when integrating a foreign context, translate at the boundary so its model can't leak into yours. Duplication across contexts is acceptable if it buys autonomy.
*Use it when*: deciding service/module boundaries — find the natural semantic seams.

### Decomposition & failure

**Nygard — Failure Thinking** (*Release It!*). For every integration point ask: what if it's *slow* (worse than down — holds resources open), returns *garbage*, is *down*, and what's the *blast radius*? Stability patterns: **timeout every external call** (no exceptions; short defaults, tune up), **circuit breaker** (stop calling after N failures, probe to resume), **bulkhead** (isolate pools so one failure can't drain all resources), **fail-fast**. Failure math: chained sync calls multiply — 5 × 99% = 95.1%; 10 × 99% = 90.4%, which is why async decoupling and breakers aren't optional at scale.
*Use it when*: any plan touches an external dependency. (Mirrors the planner's own Failure-Modes table — apply it to code-level calls.)

**Helland — Designing Around Impossibility.** At scale, distributed transactions are impractical — accept it. Define entities as the unit of atomicity (one entity = one transactional boundary); coordinate between entities with messaging; require **idempotence everywhere** (messages arrive more than once); tolerate reordering. Immutability (append-only) eliminates whole classes of coordination problems — "accountants don't use erasers."
*Use it when*: designing anything that spans more than one transactional boundary.

**Conway's Law.** Systems mirror the communication structure of the org that builds them — a law, not a suggestion (4 backend teams → 4 backend services). Before choosing architecture, ask what the org structure is; that's what the system will converge toward. Two strategies: **inverse-Conway maneuver** (change the org to match the desired architecture) or accept reality and design what the org can actually maintain. Formalize the inevitable boundaries with explicit interfaces instead of fighting them.
*Use it when*: an architecture and the team topology disagree — one of them must move.

### Pre-design & expertise

**Lamport — Invariants First.** Specify *what* the system does (behavior + invariants + edge cases) before deciding *how*. You don't need TLA+: write a one-page "what, not how" doc, list every invariant ("total money in the system never changes"), have someone find holes, then implement. Catching a design error in a spec costs minutes; in production, days.
*Use it when*: starting any non-trivial component — write the invariants as assertions first.

**Beck — TDD / structure-vs-behavior.** Tight loop: failing test → make it pass → remove duplication → improve names. **Critical rule: never change behavior and structure at the same time** — alternate "make it work" and "make it right" as distinct steps. Preparatory-refactoring heuristic: "make the change easy (this may be hard), then make the easy change." Helps most when the design space is well-understood; less for exploratory or hardware-shaped work.
*Use it when*: a change "feels hard" — that's the signal a preparatory refactor is missing.

**Writing as Thinking.** Top engineers use writing to *make* decisions, not just record them. Write *before* designing, when the same discussion recurs 3+ times, when evaluating new tech, or when a decision is hard to reverse. Formats: RFC/design doc (proposal needing input), ADR (decision + context), PR-FAQ (product, working backwards from the customer). If you can't write a clear comment explaining a module, the design isn't clear yet.
*Use it when*: a decision is contested or irreversible — the planner's `decisions.md` is exactly this discipline applied to a plan.

**Blow — Knowledge Degradation.** Technology degrades by default: each abstraction layer adds weight, knowledge transfer between generations is lossy, people build on systems they don't understand. The sustainable long-term complexity of a system is LESS than what one person can build today. **Build only what you can maintain, explain to someone else, and hand off cleanly.**
*Use it when*: adopting a dependency or pattern you don't fully understand — that's future degradation debt.

**Expertise progression** (where the failure mode shifts):

| Level | Focus | Failure mode |
|---|---|---|
| Junior | making code work | clever solutions nobody can read |
| Mid | seeing patterns across problems | over-engineering, premature abstraction |
| Senior | systems thinking, second-order effects | analysis paralysis, gold-plating |
| Staff+ | org-level synthesis, choosing the problem | disconnection from implementation reality |

Mental shifts: "make it work" → "manage complexity"; "solve the problem" → "choose the right problem"; "clever" → "obvious"; "my code" → "our system". AI-era addendum: AI collapses implementation cost, so **decision quality becomes the bottleneck** — trade-off reasoning matters more, not less.
*Use it when*: calibrating how much rigor a task deserves and which failure mode you're personally prone to.

## B. Python architecture patterns

Condensed from Cosmic Python (Percival & Gregory) plus Hettinger, McKinney, Montani, Shaw. These are the structural patterns for Python software with non-trivial business logic. Each entry: when-to-use + the smallest illustrative form. **Read §B.16 (when NOT to apply) first** — most code should NOT reach for these.

### B.1 Dependency Inversion + Hexagonal (Ports & Adapters)

High-level modules must not depend on low-level ones; both depend on abstractions. In Python: domain/business logic **never imports** SQLAlchemy, Flask, Redis, or requests — infrastructure *implements* interfaces the domain defines via `Protocol` or ABC.
**The acid test**: can you unit-test your entire business logic with no database, network, or filesystem? If no, your dependencies are inverted. Hexagonal layout: pure domain at the center, service layer around it, adapters (Flask | CLI | Celery | tests | DB | queue) at the edges plugging into ports.
*Use it when*: you need swappable infrastructure or fast unit tests. Target the test pyramid — many fast unit tests, some integration, few E2E; if most tests need a DB the architecture is wrong.

### B.2 Layered architecture

Four layers, dependencies point inward only:

| Layer | Holds | Rule |
|---|---|---|
| Presentation | Flask routes, CLI, Celery tasks | thin — zero business logic |
| Service | use-case orchestration | calls domain, owns the transaction |
| Domain | rules, invariants, entities | pure Python, no I/O, **imports nothing from the project** |
| Infrastructure | SQLAlchemy, Redis, S3 | implements domain ports |

The leak to catch: a business rule (`if qty <= 0`) or an infrastructure call (`db.session.commit()`) inside a route. Push the rule down to the domain and the commit into the service/UoW.

### B.3 Domain modeling (DDD tactical patterns)

- **Value Object** — `@dataclass(frozen=True)`, equality by value, validate in `__post_init__`. Use instead of a primitive when a `str`/`int` carries domain meaning (`Money`, `OrderId`, `EmailAddress`). `Money(100,'GBP') == Money(100,'GBP')`.
- **Entity** — identity by id, not value: define `__eq__`/`__hash__` on the id field; mutable state is fine. Two entities with the same id are the same thing even if other fields differ.
- **Domain Service** — a stateless function over domain objects for logic that belongs to no single entity (e.g. `allocate(line, batches) -> ref`).

```python
@dataclass(frozen=True)
class Money:
    amount: int       # pence/cents — never float for money
    currency: str
    def __add__(self, o: "Money") -> "Money":
        if self.currency != o.currency: raise CurrencyMismatch
        return Money(self.amount + o.amount, self.currency)
```

### B.4 Repository + Fake

A `Protocol` port the domain owns; a real adapter wraps the DB session; an in-memory fake makes tests DB-free. The fake is the payoff — same interface, a list instead of a session.

```python
class BatchRepository(Protocol):
    def add(self, b: Batch) -> None: ...
    def get(self, ref: str) -> Batch | None: ...

class FakeBatchRepository:               # tests use this — no DB
    def __init__(self, batches=None): self._b = list(batches or [])
    def add(self, b): self._b.append(b)
    def get(self, ref): return next((x for x in self._b if x.reference == ref), None)
```

The ORM maps infrastructure → domain (`orm.py` imports the domain model, never the reverse), keeping the domain pure. (SQLAlchemy 2.0+ `Mapped`/`mapped_column` is the modern API; the principle is unchanged.)

### B.5 Service Layer

One function per use case; primitives in, primitives out (never leak a domain object to the caller). Shape: fetch from repo → validate pre-conditions → call domain → commit via UoW → return a primitive.

```python
def allocate(orderid: str, sku: str, qty: int, uow) -> str:   # not (line: OrderLine, ...)
    with uow:
        product = uow.products.get(sku)
        if product is None: raise InvalidSku(sku)
        ref = model.allocate(OrderLine(orderid, sku, qty), product.batches)
        uow.commit()
    return ref
```

### B.6 Unit of Work

A context manager that is the transaction boundary: `__enter__` opens the session/repos, `__exit__` rolls back by default, `commit()` is explicit. Nothing persists unless the body reaches `uow.commit()`. The fake just flips a `committed` flag — tests assert on it without a DB.

```python
class AbstractUnitOfWork(ABC):
    products: "AbstractRepository"
    def __enter__(self): return self
    def __exit__(self, *a): self.rollback()
    @abstractmethod
    def commit(self): ...
    @abstractmethod
    def rollback(self): ...
```

### B.7 Aggregates

An aggregate is a consistency boundary: all changes to objects inside it go through the **root**. Define **one repository per aggregate root** (not per table). Hold a `version_number` on the root and bump it on every change for optimistic concurrency. The root also collects domain events for the message bus.

```python
@dataclass
class Product:                       # root; Batch/OrderLine reached only through it
    sku: str
    batches: list[Batch] = field(default_factory=list)
    version_number: int = 0          # optimistic-concurrency guard
    events: list = field(default_factory=list, repr=False)
```

### B.8 Event-driven + Message Bus

Domain events are `@dataclass(frozen=True)` records named in past tense. A message bus dispatches them to handlers; processing one event can enqueue more.

| | Command | Event |
|---|---|---|
| Name | imperative `Allocate` | past tense `Allocated` |
| Recipients | exactly one (may reject) | zero or more (cannot reject) |
| On failure | raises | handled in background |

```python
def handle(self, message):
    queue = [message]
    while queue:
        msg = queue.pop(0)
        if isinstance(msg, events.Event):
            for h in self.event_handlers.get(type(msg), []): h(msg)
        elif isinstance(msg, commands.Command):
            self.command_handlers[type(msg)](msg)
        queue.extend(self.uow.collect_new_events())
```

### B.9 CQRS

Domain models are for **writing**; use direct SQL for **reading** (skip ORM traversal and N+1 on the read path). Optionally maintain denormalized read models updated by event handlers for hot queries.

```python
def get_allocations(orderid: str, session) -> list[dict]:    # read side: plain SQL
    rows = session.execute(text("SELECT sku, batchref FROM allocations_view WHERE orderid=:o"),
                           {"o": orderid})
    return [dict(r) for r in rows]
```

### B.10 Dependency Injection + Bootstrap

Inject collaborators through the constructor (no module-level globals, no hard-coded adapters). Wire concretions **only at the edge** in a `bootstrap()` function; tests call the same bootstrap with fakes.

```python
def bootstrap(uow=None, send_mail=None) -> MessageBus:
    uow = uow or SqlAlchemyUnitOfWork()           # real concretions at the edge
    send_mail = send_mail or email.send
    return MessageBus(uow=uow, ...)

def bootstrap_test():                              # same wiring, fake everything
    return bootstrap(uow=FakeUnitOfWork(), send_mail=Mock())
```

### B.11 Pipeline (Montani)

A sequence of stateless callables over a shared doc object, plus a registry so components are config-swappable. Build **bottom-up**: the caller composes objects; do not pass a config dict that buries defaults.

```python
class Pipeline:
    def __init__(self, components: list[tuple[str, Callable]]): self._c = components
    def __call__(self, text: str) -> Doc:
        doc = Doc(text=text)
        for _, comp in self._c: doc = comp(doc)
        return doc
# registry: @register("ner.v2") on each component; Pipeline([(n, registry[f]) for n,f in cfg.items()])
```

### B.12 Composable Data Stack (McKinney)

Layer a data analysis explicitly instead of tangling load/clean/compute in one function: small pure functions chained with `df.pipe(...)`, each independently testable. Layered stack: query/API (Ibis, SQL, pandas) → execution (DuckDB, Polars, Spark — swappable) → interchange (Apache Arrow, zero-copy columnar) → storage (Parquet, Iceberg). Reach for Arrow/Parquet for large in-memory datasets.

```python
def run(path) -> dict:
    return (load(path).pipe(clean).pipe(compute_margins)
            .groupby("region")["margin"].mean().to_dict())
```

### B.13 Class architecture (Hettinger)

- **Cooperative `super()` / MRO** — `super().method()` walks the method-resolution order, not just the literal parent, so mixins chain (`LoggingMixin, TimestampMixin, BaseModel` → each `save()` calls `super().save()`).
- **`__slots__` flyweight** — declare `__slots__` to drop per-instance `__dict__`: ~200B → ~40-80B per object. Critical at millions of instances.
- **Template method** — base `run()` fixes the algorithm skeleton (`fetch → clean → transform`); subclasses override the steps.

### B.14 GIL / concurrency decision table

| Workload | Tool | Why |
|---|---|---|
| CPU-bound | `ProcessPoolExecutor` | each process has its own GIL |
| I/O-bound | `asyncio` / `ThreadPoolExecutor` | GIL released during I/O |
| Mixed | `asyncio` + `run_in_executor` for the CPU part | best of both |

Two asyncio pitfalls that silently kill concurrency:
1. **Blocking call inside `async`** — `requests.get(...)` in a coroutine freezes the whole event loop. Use an async client (`httpx.AsyncClient`).
2. **Sequential when it should be concurrent** — `a = await f(); b = await g()` runs serially. Use `a, b = await asyncio.gather(f(), g())`.

(Mirrors Section A's "I/O-bound → async; CPU-bound → processes" heuristic — applied at the code level.)

### B.15 Canonical Python project structure

`src/` layout, dependencies point inward, enforced by `import-linter` in CI:

```
src/allocation/
├── domain/         # pure Python — zero project/infrastructure imports
├── service_layer/  # handlers.py, messagebus.py, unit_of_work.py
├── adapters/       # orm.py, repository.py (import domain)
└── entrypoints/    # flask_app.py, redis_consumer.py
tests/ {unit/ (FakeUoW, no I/O), integration/ (real infra), e2e/}
```

Import discipline: `entrypoints → service_layer, adapters`; `adapters → domain`; `service_layer → domain`; `domain → nothing from this project`. Illegal: domain importing service_layer or adapters. Config comes from the environment (`os.environ.get(..., default)`), never hard-coded.

### B.16 When NOT to apply these patterns (read first)

These patterns earn their keep only with **non-trivial business logic that changes often, multiple teams, swappable infrastructure, or DB-slow CI**. For CRUD APIs, data-science scripts, prototypes, and thin API wrappers they are pure over-engineering — the minimal route below *is* the correct architecture:

```python
@app.route("/users", methods=["POST"])     # correct for simple CRUD — do NOT add layers
def create_user():
    user = User(**request.json)
    db.session.add(user); db.session.commit()
    return {"id": user.id}, 201
```

Decision matrix — reach for a pattern only when the situation on the left is real:

| Situation | Pattern |
|---|---|
| Business logic growing complex | Domain Model |
| Tests need a database | Repository + Fake |
| Use cases scattered across views | Service Layer |
| Atomic multi-step operations | Unit of Work |
| Cross-aggregate consistency | Domain Events + Message Bus |
| Slow/complex read queries | CQRS — direct SQL reads |
| Hard-to-test constructors | DI + Bootstrap |
| Multiple infrastructure backends | Ports & Adapters |
| Sequence of data transforms | Pipeline + registry |
| I/O-bound concurrency | `asyncio` + `gather` |
| CPU-bound parallelism | `ProcessPoolExecutor` |
| Large in-memory datasets | Arrow / Parquet |
| **Simple CRUD / script / prototype** | **None — use the ORM directly** |
