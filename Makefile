# Makefile for Iterative Planner Claude Skill
# Packages the repository into a distributable Claude skill format

SKILL_NAME := iterative-planner
VERSION := $(shell cat VERSION)
BUILD_DIR := build
DIST_DIR := dist

# Local install destinations for the opt-in sync-skill target (writes to $HOME)
SKILL_INSTALL_DIR := $(HOME)/.claude/skills/$(SKILL_NAME)
AGENTS_INSTALL_DIR := $(HOME)/.claude/agents

# Files to include in the skill package
SKILL_FILE := src/SKILL.md
REFERENCE_FILES := $(sort $(wildcard src/references/*.md))
SCRIPT_FILES := $(filter-out %.test.mjs,$(wildcard src/scripts/*.mjs)) $(wildcard src/scripts/*.json)
MODULE_FILES := $(sort $(wildcard src/scripts/modules/*.md))
AGENT_FILES := $(sort $(wildcard src/agents/*.md))
# VERSION ships INSIDE the package: bootstrap.mjs resolves the skill version at runtime by
# probing <pkg>/VERSION (installed layout) / <repo>/VERSION (dev layout). If VERSION is not
# copied here, the installed skill has no VERSION file and every new plan is stamped
# "unknown". Keep it in DOC_FILES, in sync-skill's copy set, AND in sync-skill's diff list.
DOC_FILES := README.md LICENSE CHANGELOG.md VERSION

# Default target
.PHONY: all
all: package

# Build the skill package structure
.PHONY: build
build:
	@echo "Building skill package: $(SKILL_NAME)"
	mkdir -p $(BUILD_DIR)/$(SKILL_NAME)
	mkdir -p $(BUILD_DIR)/$(SKILL_NAME)/references
	mkdir -p $(BUILD_DIR)/$(SKILL_NAME)/scripts
	mkdir -p $(BUILD_DIR)/$(SKILL_NAME)/scripts/modules
	@# Copy main skill file
	cp $(SKILL_FILE) $(BUILD_DIR)/$(SKILL_NAME)/
	sed -i "s/__SKILL_VERSION__/$(VERSION)/g" $(BUILD_DIR)/$(SKILL_NAME)/SKILL.md
	sed -i "s/__SKILL_DATE__/$$(date -u +%Y-%m-%d)/g" $(BUILD_DIR)/$(SKILL_NAME)/SKILL.md
	sed -i "s/__SKILL_COMMIT__/$$(git rev-parse --short HEAD)/g" $(BUILD_DIR)/$(SKILL_NAME)/SKILL.md
	@# Copy reference files
	cp $(REFERENCE_FILES) $(BUILD_DIR)/$(SKILL_NAME)/references/
	@# Copy scripts
	cp $(SCRIPT_FILES) $(BUILD_DIR)/$(SKILL_NAME)/scripts/
	@# Copy per-state rule modules (emitted on demand by emit-state.mjs)
	cp $(MODULE_FILES) $(BUILD_DIR)/$(SKILL_NAME)/scripts/modules/
	@# Copy agent definitions (if any)
	@if [ -n "$(AGENT_FILES)" ]; then \
		mkdir -p $(BUILD_DIR)/$(SKILL_NAME)/agents; \
		cp $(AGENT_FILES) $(BUILD_DIR)/$(SKILL_NAME)/agents/; \
	fi
	@# Copy documentation
	cp $(DOC_FILES) $(BUILD_DIR)/$(SKILL_NAME)/ 2>/dev/null || true
	@echo "Build complete: $(BUILD_DIR)/$(SKILL_NAME)"

# Create a combined single-file skill (SKILL.md with references inlined)
.PHONY: build-combined
build-combined:
	@echo "Building combined single-file skill..."
	mkdir -p $(BUILD_DIR)
	cp $(SKILL_FILE) $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "---" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "# Bundled References" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@for ref in $(REFERENCE_FILES); do \
		echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md; \
		echo "---" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md; \
		echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md; \
		cat $$ref >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md; \
	done
	@# Re-inline the per-state rule modules so the single-file channel is self-contained
	@# (emit-state.mjs is not runnable in a paste context — the bodies must be baked in).
	@echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "---" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "# Bundled State Modules" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@for mod in $(MODULE_FILES); do \
		state=$$(basename $$mod .md | sed 's/^state-//'); \
		echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md; \
		echo "---" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md; \
		echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md; \
		echo "## State Module: $$state" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md; \
		echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md; \
		cat $$mod >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md; \
	done
	@echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "---" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "> **Note**: This combined file does not include \`bootstrap.mjs\` or the sub-agent" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "> definitions (\`src/agents/*.md\`) — it runs in SKILL.md's single-thread monolithic-fallback" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "> mode. Bootstrap commands referenced in the protocol require the full package. Plan" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "> directories must be created manually or by using the zip/tarball distribution." >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@# Rewrite references/ cross-references to anchor links (content is inlined above)
	@sed -i 's|`references/blast-radius\.md`|the Blast Radius Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`references/code-hygiene\.md`|the Code Hygiene Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`references/complexity-control\.md`|the Complexity Control Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`references/convergence-metrics\.md`|the Convergence Metrics Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`references/decision-anchoring\.md`|the Decision Anchoring Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`references/file-formats\.md`|the File Formats Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`references/planning-rigor\.md`|the Planning Rigor Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`references/python-software\.md`|the Python / Software-Engineering Caveat section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`src/references/blast-radius\.md`|the Blast Radius Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`src/references/code-hygiene\.md`|the Code Hygiene Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`src/references/complexity-control\.md`|the Complexity Control Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`src/references/convergence-metrics\.md`|the Convergence Metrics Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`src/references/decision-anchoring\.md`|the Decision Anchoring Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`src/references/file-formats\.md`|the File Formats Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`src/references/planning-rigor\.md`|the Planning Rigor Reference section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@sed -i 's|`src/references/python-software\.md`|the Python / Software-Engineering Caveat section below|g' $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	sed -i "s/__SKILL_VERSION__/$(VERSION)/g" $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	sed -i "s/__SKILL_DATE__/$$(date -u +%Y-%m-%d)/g" $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	sed -i "s/__SKILL_COMMIT__/$$(git rev-parse --short HEAD)/g" $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "Combined skill created: $(BUILD_DIR)/$(SKILL_NAME)-combined.md"

# Package as zip for distribution
.PHONY: package
package: validate build
	@echo "Packaging skill as zip..."
	mkdir -p $(DIST_DIR)
	cd $(BUILD_DIR) && zip -r ../$(DIST_DIR)/$(SKILL_NAME)-v$(VERSION).zip $(SKILL_NAME)
	@echo "Package created: $(DIST_DIR)/$(SKILL_NAME)-v$(VERSION).zip"

# Package combined single-file version
.PHONY: package-combined
package-combined: validate build-combined
	mkdir -p $(DIST_DIR)
	cp $(BUILD_DIR)/$(SKILL_NAME)-combined.md $(DIST_DIR)/
	@echo "Combined skill copied to: $(DIST_DIR)/$(SKILL_NAME)-combined.md"

# Create tarball
.PHONY: package-tar
package-tar: validate build
	@echo "Packaging skill as tarball..."
	mkdir -p $(DIST_DIR)
	cd $(BUILD_DIR) && tar -czvf ../$(DIST_DIR)/$(SKILL_NAME)-v$(VERSION).tar.gz $(SKILL_NAME)
	@echo "Package created: $(DIST_DIR)/$(SKILL_NAME)-v$(VERSION).tar.gz"

# Validate skill structure
.PHONY: validate
validate:
	@echo "Validating skill structure..."
	@test -f $(SKILL_FILE) || (echo "ERROR: $(SKILL_FILE) not found" && exit 1)
	@grep -q "^name:" $(SKILL_FILE) || (echo "ERROR: SKILL.md missing 'name' in frontmatter" && exit 1)
	@grep -q "^description:" $(SKILL_FILE) || (echo "ERROR: SKILL.md missing 'description' in frontmatter" && exit 1)
	@test -d src/references || (echo "ERROR: src/references/ directory not found" && exit 1)
	@test -d src/scripts || (echo "ERROR: src/scripts/ directory not found" && exit 1)
	@# Verify all references/ cross-references in SKILL.md resolve to actual files
	@echo "Checking cross-references..."
	@for ref in $$(grep -oE 'references/[a-z0-9_-]+\.md' $(SKILL_FILE) | sort -u); do \
		test -f "src/$$ref" || (echo "ERROR: $(SKILL_FILE) references src/$$ref but file not found" && exit 1); \
	done
	@# Verify bootstrap.mjs creates expected plan directory files
	@echo "Checking bootstrap file list..."
	@for f in state.md plan.md decisions.md findings.md progress.md verification.md changelog.md; do \
		grep -q "\"$$f\"" src/scripts/bootstrap.mjs || \
		grep -q "'$$f'" src/scripts/bootstrap.mjs || \
		grep -q "$$f" src/scripts/bootstrap.mjs || \
		(echo "ERROR: bootstrap.mjs does not create $$f" && exit 1); \
	done
	@# Verify bootstrap.mjs creates expected subdirectories
	@echo "Checking bootstrap directory creation..."
	@for d in checkpoints findings; do \
		grep -q "$$d" src/scripts/bootstrap.mjs || \
		(echo "ERROR: bootstrap.mjs does not create $$d/ directory" && exit 1); \
	done
	@# Verify bootstrap.mjs references consolidated files
	@echo "Checking consolidated file references..."
	@grep -q "FINDINGS.md" src/scripts/bootstrap.mjs || \
		(echo "ERROR: bootstrap.mjs does not reference FINDINGS.md" && exit 1)
	@grep -q "DECISIONS.md" src/scripts/bootstrap.mjs || \
		(echo "ERROR: bootstrap.mjs does not reference DECISIONS.md" && exit 1)
	@grep -q "LESSONS.md" src/scripts/bootstrap.mjs || \
		(echo "ERROR: bootstrap.mjs does not reference LESSONS.md" && exit 1)
	@grep -q "INDEX.md" src/scripts/bootstrap.mjs || \
		(echo "ERROR: bootstrap.mjs does not reference INDEX.md" && exit 1)
	@# Verify agent definitions have required frontmatter
	@echo "Checking agent definitions..."
	@if [ -d src/agents ]; then \
		for agent in src/agents/*.md; do \
			grep -q "^name:" "$$agent" || (echo "ERROR: $$agent missing 'name' in frontmatter" && exit 1); \
			grep -q "^description:" "$$agent" || (echo "ERROR: $$agent missing 'description' in frontmatter" && exit 1); \
			grep -q "^tools:" "$$agent" || (echo "ERROR: $$agent missing 'tools' in frontmatter" && exit 1); \
		done; \
	fi
	@# Verify transition table entries appear in Mermaid diagram
	@echo "Checking state machine consistency..."
	@for pair in "EXPLORE.*PLAN" "PLAN.*EXPLORE" "PLAN.*PLAN" "PLAN.*EXECUTE" "EXECUTE.*REFLECT" \
		"REFLECT.*CLOSE" "REFLECT.*PIVOT" "REFLECT.*EXPLORE" "PIVOT.*PLAN"; do \
		grep -qE "$$pair" $(SKILL_FILE) || \
		(echo "ERROR: Transition $$pair missing from SKILL.md" && exit 1); \
	done
	@# Verify validate-plan.mjs VALID_TRANSITIONS covers all SKILL.md transitions
	@echo "Checking validator transition coverage..."
	@for pair in "EXPLORE→PLAN" "PLAN→EXPLORE" "PLAN→PLAN" "PLAN→EXECUTE" "EXECUTE→REFLECT" \
		"REFLECT→CLOSE" "REFLECT→PIVOT" "REFLECT→EXPLORE" "PIVOT→PLAN"; do \
		grep -qF "\"$$pair\"" src/scripts/validate-plan.mjs || \
		(echo "ERROR: validate-plan.mjs VALID_TRANSITIONS missing $$pair" && exit 1); \
	done
	@# Verify README <-> SKILL.md File Ownership table parity
	@echo "Checking doc parity (README <-> SKILL.md File Ownership)..."
	@node src/scripts/check-doc-parity.mjs || exit 1
	@# Verify README version badge and test-count badge match VERSION and TEST_COUNT files
	@echo "Checking README badge parity (version + test count)..."
	@node src/scripts/check-readme-parity.mjs || exit 1
	@# Verify CHANGELOG.md's first "## [X.Y.Z]" entry matches the VERSION file
	@echo "Checking CHANGELOG parity (top entry <-> VERSION)..."
	@node src/scripts/check-changelog-parity.mjs || exit 1
	@# Verify agent/module prose wiring: script paths, reference citations, section pointers, skill-path resolution
	@# --emit-edges is opt-in at the call sites (this line +
	@# build.ps1 Invoke-Validate — a 2-place lockstep fact; edit both together). Do NOT make emission default-on
	@# in check-agent-wiring.mjs: no-flag runs must stay read-only (first-of-kind writer among check-* gates).
	@# No explicit path — the default src/references/kg-edges.jsonl applies. See decisions.md D-003.
	@echo "Checking agent wiring (script paths, references, section pointers)..."
	@node src/scripts/check-agent-wiring.mjs --emit-edges || exit 1
	@# Verify bootstrap's PLAN_TEMPLATES byte-match file-formats.md's <!-- SKELETON:* --> regions
	@echo "Checking template parity (bootstrap PLAN_TEMPLATES <-> file-formats.md skeletons)..."
	@node src/scripts/check-template-parity.mjs || exit 1
	@# Verify register density (jargon-marker ratchet) against committed per-file ceilings
	@echo "Checking register density (jargon-marker ratchet)..."
	@node src/scripts/check-register.mjs || exit 1
	@echo "Validation passed!"

# Check script syntax
.PHONY: lint
lint:
	@# NOTE: unused-import detection is intentionally NOT performed here. The repo is dependency-free
	@# (all imports are Node builtins or ./shared.mjs); a real import linter would require an npm
	@# dependency, violating the dependency-free invariant. Syntax-only by design — do NOT add an
	@# import-linter or any npm tooling.
	@echo "Checking script syntax..."
	node --check src/scripts/bootstrap.mjs
	node --check src/scripts/validate-plan.mjs
	node --check src/scripts/blast-radius.mjs
	node --check src/scripts/shared.mjs
	node --check src/scripts/check-doc-parity.mjs
	node --check src/scripts/check-readme-parity.mjs
	node --check src/scripts/check-changelog-parity.mjs
	node --check src/scripts/check-test-count.mjs
	node --check src/scripts/check-agent-wiring.mjs
	node --check src/scripts/check-template-parity.mjs
	node --check src/scripts/check-register.mjs
	node --check src/scripts/emit-state.mjs
	node --check src/scripts/emit-template.mjs
	node --check src/scripts/schema.mjs
	@echo "Syntax check passed!"

# Run tests
# NOTE: check-test-count.mjs is wired here and NOT into `validate` — it re-runs the
# suite (defect #7: nothing compared TEST_COUNT against reality; README<->TEST_COUNT
# parity passes when BOTH are stale). `validate` must stay fast and suite-free.
# Keep this target in lockstep with build.ps1's Invoke-Test.
.PHONY: test
test: lint
	@echo "Running all test suites..."
	node --test src/scripts/bootstrap.test.mjs src/scripts/validate-plan.test.mjs src/scripts/blast-radius.test.mjs src/scripts/check-doc-parity.test.mjs src/scripts/emit-state.test.mjs src/scripts/emit-template.test.mjs src/scripts/check-readme-parity.test.mjs src/scripts/check-changelog-parity.test.mjs src/scripts/shared.test.mjs src/scripts/check-test-count.test.mjs src/scripts/schema.test.mjs src/scripts/check-agent-wiring.test.mjs src/scripts/check-template-parity.test.mjs src/scripts/check-register.test.mjs
	@echo "Checking TEST_COUNT against the live suite result..."
	node src/scripts/check-test-count.mjs
	@echo "Tests passed!"

# Clean build artifacts
.PHONY: clean
clean:
	@echo "Cleaning build artifacts..."
	rm -rf $(BUILD_DIR)
	rm -rf $(DIST_DIR)
	rm -f src/references/kg-edges.jsonl
	@echo "Clean complete"

# Show package contents
.PHONY: list
list: build
	@echo "Package contents:"
	@find $(BUILD_DIR)/$(SKILL_NAME) -type f | sort

# Opt-in: deploy repo source to the local installed skill (writes to $HOME). Not a prereq of build/package.
.PHONY: sync-skill
sync-skill:
	@echo "Syncing repo source to local installed skill: $(SKILL_INSTALL_DIR)"
	mkdir -p $(SKILL_INSTALL_DIR)/references
	mkdir -p $(SKILL_INSTALL_DIR)/scripts
	mkdir -p $(SKILL_INSTALL_DIR)/scripts/modules
	mkdir -p $(SKILL_INSTALL_DIR)/agents
	mkdir -p $(AGENTS_INSTALL_DIR)
# Prune before copy: `cp` alone cannot remove a file that was DELETED from the repo, so a
# copy-only sync leaves orphans behind forever (v2.35.0 removed xml.mjs/changelog.mjs; a
# copy-only sync would have left both live in the install). Prune by glob, per directory.
# The four dirs below are wholly owned by this skill, so a glob prune is safe there.
	rm -f $(SKILL_INSTALL_DIR)/scripts/*.mjs
	rm -f $(SKILL_INSTALL_DIR)/scripts/*.json
	rm -f $(SKILL_INSTALL_DIR)/scripts/modules/*.md
	rm -f $(SKILL_INSTALL_DIR)/references/*.md
	rm -f $(SKILL_INSTALL_DIR)/agents/*.md
# $(AGENTS_INSTALL_DIR) is SHARED with every other installed skill. Prune ONLY our own
# ip-*.md agents here — a glob prune would delete other skills' agent definitions.
	rm -f $(AGENTS_INSTALL_DIR)/ip-*.md
	cp src/SKILL.md $(SKILL_INSTALL_DIR)/SKILL.md
# Copy scripts via $(SCRIPT_FILES), which already excludes %.test.mjs and includes the .json
# gate-data files. The raw `cp src/scripts/*.mjs` glob shipped all *.test.mjs into the live
# install (D-008 regression, re-fixed here); do NOT revert to it. See decisions.md D-002.
	cp $(SCRIPT_FILES) $(SKILL_INSTALL_DIR)/scripts/
	cp src/scripts/modules/*.md $(SKILL_INSTALL_DIR)/scripts/modules/
	cp src/references/*.md $(SKILL_INSTALL_DIR)/references/
	cp README.md LICENSE CHANGELOG.md VERSION $(SKILL_INSTALL_DIR)/
	cp src/agents/*.md $(SKILL_INSTALL_DIR)/agents/
	cp src/agents/*.md $(AGENTS_INSTALL_DIR)/
# Verify ALL synced trees, not just agents+modules. The old check diffed only those two, so a
# stale script or reference could survive a "Sync verified." with no complaint.
# kg-edges.jsonl is generated-only (gitignored, regenerated
# by every `make validate`, removed by `clean`). It must NOT be committed, synced, or shipped — do NOT drop
# this exclusion or widen any src/references/*.md copy glob to include it. Gitignore does not hide files
# from `diff -rq`, hence the explicit exclude here. See decisions.md D-002.
# Exclude *.test.mjs from the scripts diff — the copy above deliberately ships no test files, so
# an unfiltered diff would false-fail on every src-side test file as "only in src/scripts".
# The guard below then asserts, non-vacuously, that ZERO test files leaked into the install
# (restoring D-008's verification shape — the old whole-dir diff passed vacuously). See D-002.
	@test -z "$$(ls $(SKILL_INSTALL_DIR)/scripts/*.test.mjs 2>/dev/null)" || { echo "ERROR: sync-skill shipped *.test.mjs into the install (D-008 regression)" && exit 1; }
	@diff -rq --exclude='.claude' --exclude='*.test.mjs' src/scripts $(SKILL_INSTALL_DIR)/scripts \
	  && diff -rq --exclude='.claude' --exclude='kg-edges.jsonl' src/references $(SKILL_INSTALL_DIR)/references \
	  && diff -rq --exclude='.claude' src/agents $(SKILL_INSTALL_DIR)/agents \
	  && diff -rq --exclude='.claude' src/scripts/modules $(SKILL_INSTALL_DIR)/scripts/modules \
	  && diff -q src/SKILL.md $(SKILL_INSTALL_DIR)/SKILL.md \
	  && diff -q VERSION $(SKILL_INSTALL_DIR)/VERSION \
	  && echo "Sync verified (scripts, references, agents, modules, SKILL.md, VERSION)." \
	  || (echo "ERROR: sync diff mismatch" && exit 1)

# Help
.PHONY: help
help:
	@echo "Iterative Planner Skill - Makefile targets:"
	@echo ""
	@echo "  make build           - Build skill package structure"
	@echo "  make build-combined  - Build single-file skill with inlined references"
	@echo "  make package         - Create zip package (default)"
	@echo "  make package-combined - Create single-file skill package"
	@echo "  make package-tar     - Create tarball package"
	@echo "  make validate        - Validate skill structure"
	@echo "  make lint            - Check script syntax"
	@echo "  make test            - Run tests"
	@echo "  make clean           - Remove build artifacts"
	@echo "  make list            - Show package contents"
	@echo "  make sync-skill      - Opt-in: deploy repo source to local installed skill (writes to \$$HOME)"
	@echo "  make help            - Show this help"
	@echo ""
	@echo "Skill: $(SKILL_NAME) v$(VERSION)"
