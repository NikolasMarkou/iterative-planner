# Makefile for Iterative Planner Claude Skill
# Packages the repository into a distributable Claude skill format

SKILL_NAME := iterative-planner
VERSION := $(shell cat VERSION)
BUILD_DIR := build
DIST_DIR := dist

# Files to include in the skill package
SKILL_FILE := src/SKILL.md
REFERENCE_FILES := $(wildcard src/references/*.md)
SCRIPT_FILES := $(wildcard src/scripts/*.mjs)
DOC_FILES := README.md LICENSE CHANGELOG.md

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
	@# Copy main skill file
	cp $(SKILL_FILE) $(BUILD_DIR)/$(SKILL_NAME)/
	@# Copy reference files
	cp $(REFERENCE_FILES) $(BUILD_DIR)/$(SKILL_NAME)/references/
	@# Copy scripts
	cp $(SCRIPT_FILES) $(BUILD_DIR)/$(SKILL_NAME)/scripts/
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
	@echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "---" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "> **Note**: This combined file does not include \`bootstrap.mjs\`. Bootstrap commands" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "> referenced in the protocol require the full package. Plan directories must be" >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "> created manually or by using the zip/tarball distribution." >> $(BUILD_DIR)/$(SKILL_NAME)-combined.md
	@echo "Combined skill created: $(BUILD_DIR)/$(SKILL_NAME)-combined.md"

# Package as zip for distribution
.PHONY: package
package: build
	@echo "Packaging skill as zip..."
	mkdir -p $(DIST_DIR)
	cd $(BUILD_DIR) && zip -r ../$(DIST_DIR)/$(SKILL_NAME)-v$(VERSION).zip $(SKILL_NAME)
	@echo "Package created: $(DIST_DIR)/$(SKILL_NAME)-v$(VERSION).zip"

# Package combined single-file version
.PHONY: package-combined
package-combined: build-combined
	mkdir -p $(DIST_DIR)
	cp $(BUILD_DIR)/$(SKILL_NAME)-combined.md $(DIST_DIR)/
	@echo "Combined skill copied to: $(DIST_DIR)/$(SKILL_NAME)-combined.md"

# Create tarball
.PHONY: package-tar
package-tar: build
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
	@for f in state.md plan.md decisions.md findings.md progress.md; do \
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
	@# Verify transition table entries appear in Mermaid diagram
	@echo "Checking state machine consistency..."
	@for pair in "EXPLORE.*PLAN" "PLAN.*EXPLORE" "PLAN.*PLAN" "PLAN.*EXECUTE" "EXECUTE.*REFLECT" \
		"REFLECT.*CLOSE" "REFLECT.*RE[-_]PLAN" "REFLECT.*EXPLORE" "RE[-_]PLAN.*PLAN"; do \
		grep -qE "$$pair" $(SKILL_FILE) || \
		(echo "ERROR: Transition $$pair missing from SKILL.md" && exit 1); \
	done
	@echo "Validation passed!"

# Check script syntax
.PHONY: lint
lint:
	@echo "Checking script syntax..."
	node --check src/scripts/bootstrap.mjs
	@echo "Syntax check passed!"

# Run tests
.PHONY: test
test: lint
	@echo "Running bootstrap.mjs tests..."
	@# Verify help exits cleanly
	node src/scripts/bootstrap.mjs help > /dev/null
	@# Round-trip: new → status → close (uses temp directory to avoid clobbering active plans)
	@bash -c '\
		TMPDIR=$$(mktemp -d); \
		trap "rm -rf \"$$TMPDIR\"" EXIT; \
		cd "$$TMPDIR" && \
		node "$(CURDIR)/src/scripts/bootstrap.mjs" new "test goal" > /dev/null && \
		node "$(CURDIR)/src/scripts/bootstrap.mjs" status | grep -q "test goal" && \
		node "$(CURDIR)/src/scripts/bootstrap.mjs" close > /dev/null && \
		echo "  Round-trip (new → status → close) passed."'
	@echo "Tests passed!"

# Clean build artifacts
.PHONY: clean
clean:
	@echo "Cleaning build artifacts..."
	rm -rf $(BUILD_DIR)
	rm -rf $(DIST_DIR)
	@echo "Clean complete"

# Show package contents
.PHONY: list
list: build
	@echo "Package contents:"
	@find $(BUILD_DIR)/$(SKILL_NAME) -type f | sort

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
	@echo "  make help            - Show this help"
	@echo ""
	@echo "Skill: $(SKILL_NAME) v$(VERSION)"
