# The default sandbox image: Debian with what agents reach for when they work
# on code, and a desktop they can start when a task needs a screen. Commands
# run without one; `sugabots-desktop start` gives a turn its own display.
#
#   bun run build:sandbox
#
# Builds sugabots-sandbox:latest, the image OpenSandbox providers use unless a
# workspace sets another. Sugabots makes /workspace and the agents' user when
# it makes a sandbox, so any image works; this one also has them built in.

ARG NOVNC_VERSION=1.6.0
ARG WEBSOCKIFY_VERSION=0.13.0

# Upstream noVNC and websockify rather than Debian's packages, which bring
# Node.js, numpy and OpenStack's libraries for a static page and a proxy.
FROM debian:trixie-slim AS novnc
ARG NOVNC_VERSION
ARG WEBSOCKIFY_VERSION
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& mkdir -p /novnc /websockify \
	&& curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" \
		| tar -xz --strip-components=1 -C /novnc \
	&& curl -fsSL "https://github.com/novnc/websockify/archive/refs/tags/v${WEBSOCKIFY_VERSION}.tar.gz" \
		| tar -xz --strip-components=1 -C /websockify \
	&& rm -rf /novnc/docs /novnc/tests /novnc/snap /novnc/utils /websockify/tests /websockify/docs \
	&& ln -s vnc.html /novnc/index.html

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PYTHONPATH=/opt/websockify

# The tools agents use on a repository, then the desktop: a virtual display,
# a window manager, a browser, and what computer-use tools drive them with.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates curl wget git openssh-client less file procps \
		unzip zip xz-utils jq ripgrep fd-find tree \
		build-essential pkg-config \
		python3 python3-pip python3-venv \
		nodejs npm \
		xvfb x11vnc x11-utils openbox xterm xfonts-base dbus-x11 hsetroot \
		firefox-esr xdotool scrot xclip fonts-dejavu fonts-noto-color-emoji \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=novnc /novnc /opt/novnc
COPY --from=novnc /websockify /opt/websockify
COPY sugabots-desktop /usr/local/bin/sugabots-desktop

# The agents' user: uid 1000, as the sandbox providers expect. Which user a
# command runs as is the provider's choice, so the image doesn't switch to it.
RUN groupadd -g 1000 agent \
	&& useradd -u 1000 -g 1000 -m -d /home/agent -s /bin/bash agent \
	&& mkdir -p /workspace \
	&& chown agent:agent /workspace \
	&& chmod 755 /usr/local/bin/sugabots-desktop

WORKDIR /workspace
CMD ["bash"]
