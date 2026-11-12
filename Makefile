VERSION ?= dev
IMAGENAME = eodhp-element84-proxy
DOCKERREPO ?= public.ecr.aws/eodh

.PHONY: check
check: test-unit test-integration

.PHONY: dockerbuild
dockerbuild:
	DOCKER_BUILDKIT=1 docker build -t ${IMAGENAME}:${VERSION} .

# The unit tests run under the njs CLI in the proxy's own image, so they use the same
# JavaScript engine as nginx.
.PHONY: test-unit
test-unit: dockerbuild
	docker run --rm -v "$(CURDIR)":/src:ro ${IMAGENAME}:${VERSION} njs -p /src/njs /src/tests/unit/test_stac.js

.PHONY: test-integration
test-integration: dockerbuild
	PROXY_IMAGE=${IMAGENAME}:${VERSION} tests/integration/run.sh

.PHONY: dockerpush
dockerpush: dockerbuild
	docker tag ${IMAGENAME}:${VERSION} ${DOCKERREPO}/${IMAGENAME}:${VERSION}
	docker push ${DOCKERREPO}/${IMAGENAME}:${VERSION}
