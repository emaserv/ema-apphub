import fs from 'fs';
import path from 'path';
import { BuildConfig, TECHNOLOGIES } from './detector';
import { NODE_DEFAULT } from './nodeVersion';
import { ALPINE_IMAGE, DOTNET_DEFAULT, GO_DEFAULT, NGINX_IMAGE } from './imageVersions';

/**
 * Generadores de Dockerfile por tecnología. Cada plantilla produce una imagen
 * de producción (multi-stage cuando corresponde). Para tecnologías no listadas
 * el usuario provee/edita su propio Dockerfile: la plataforma no depende de una
 * tecnología concreta, sólo de que exista una estrategia Docker válida.
 */

const header = (tech: string) => `# Generado por EMA AppHub · ${TECHNOLOGIES[tech]?.label ?? tech}\n# Puede editarse libremente desde la interfaz (pestaña Docker).\n`;

function nodeInstall(bc: BuildConfig): string {
  switch (bc.packageManager) {
    case 'pnpm': return 'corepack enable && pnpm install --frozen-lockfile';
    case 'yarn': return 'corepack enable && yarn install';
    default: return 'if [ -f package-lock.json ]; then npm ci; else npm install; fi';
  }
}
const LOCKS = 'package.json package-lock.json* yarn.lock* pnpm-lock.yaml* .npmrc*';

function spa(tech: string, bc: BuildConfig): string {
  const out = bc.outputDir || 'dist';
  return `${header(tech)}
# ---------- build ----------
FROM node:${bc.nodeVersion || NODE_DEFAULT}-alpine AS build
WORKDIR /app
COPY ${LOCKS} ./
RUN ${nodeInstall(bc)}
COPY . .
RUN ${bc.buildCommand || 'npm run build'}
# Localiza el index.html generado (dist, build, dist/<proyecto>/browser, …)
RUN set -e; d="${out}"; \\
    if [ ! -f "$d/index.html" ]; then d=$(dirname "$(find ${out} dist build -name index.html -not -path '*/node_modules/*' 2>/dev/null | head -n1)"); fi; \\
    mkdir -p /out && cp -r "$d"/. /out/

# ---------- runtime ----------
FROM ${NGINX_IMAGE}
COPY .ema/nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /out /usr/share/nginx/html
EXPOSE 80
`;
}

function nodeServer(tech: string, bc: BuildConfig, port: number): string {
  return `${header(tech)}
FROM node:${bc.nodeVersion || NODE_DEFAULT}-alpine
WORKDIR /app
RUN apk add --no-cache tini
COPY ${LOCKS} ./
RUN ${nodeInstall(bc)}
COPY . .
${bc.buildCommand ? `RUN ${bc.buildCommand}\n` : ''}ENV NODE_ENV=production \\
    PORT=${port} \\
    HOST=0.0.0.0 \\
    HOSTNAME=0.0.0.0
EXPOSE ${port}
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", ${JSON.stringify(bc.startCommand || 'npm start')}]
`;
}

function staticSite(bc: BuildConfig): string {
  const root = bc.docRoot ? bc.docRoot.replace(/^\/+|\/+$/g, '') + '/' : '.';
  return `${header('static')}
FROM ${NGINX_IMAGE}
COPY .ema/nginx-static.conf /etc/nginx/conf.d/default.conf
COPY ${root} /usr/share/nginx/html
RUN rm -rf /usr/share/nginx/html/.ema /usr/share/nginx/html/Dockerfile
EXPOSE 80
`;
}

function python(tech: string, bc: BuildConfig, port: number): string {
  const extra = tech === 'python-fastapi' ? 'uvicorn[standard]' : tech === 'python' ? '' : 'gunicorn';
  const start = (bc.startCommand || 'python main.py').replace(/8000/g, String(port));
  return `${header(tech)}
FROM python:${bc.pythonVersion || '3.12'}-slim
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1 \\
    PIP_NO_CACHE_DIR=1 \\
    PORT=${port}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev curl \\
    && rm -rf /var/lib/apt/lists/*
COPY requirements*.txt* ./
RUN if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
COPY . .
RUN if [ ! -f requirements.txt ] && [ -f pyproject.toml ]; then pip install .; fi
${extra ? `RUN pip install ${extra}\n` : ''}${tech === 'python-django' ? 'RUN python manage.py collectstatic --noinput || true\n' : ''}EXPOSE ${port}
CMD ["sh", "-c", ${JSON.stringify(start)}]
`;
}

function php(tech: string, bc: BuildConfig): string {
  const docroot = bc.docRoot ? `/var/www/html/${bc.docRoot}` : '/var/www/html';
  return `${header(tech)}
FROM php:${bc.phpVersion || '8.3'}-apache
RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev libzip-dev unzip git \\
    && docker-php-ext-install pdo pdo_pgsql pgsql pdo_mysql mysqli zip \\
    && a2enmod rewrite headers \\
    && rm -rf /var/lib/apt/lists/*
ENV APACHE_DOCUMENT_ROOT=${docroot}
RUN sed -ri -e 's!/var/www/html!\${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/sites-available/*.conf \\
    && sed -ri -e 's!/var/www/!\${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf \\
    && sed -ri -e 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /var/www/html
COPY . .
RUN if [ -f composer.json ]; then composer install --no-dev --optimize-autoloader --no-interaction --no-progress; fi
${tech === 'php-laravel' ? 'RUN mkdir -p storage bootstrap/cache && chown -R www-data:www-data storage bootstrap/cache\n' : ''}RUN chown -R www-data:www-data /var/www/html
EXPOSE 80
`;
}

function maven(bc: BuildConfig, port: number): string {
  const v = bc.javaVersion || '21';
  return `${header('java-maven')}
FROM maven:3.9-eclipse-temurin-${v} AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -B -q dependency:go-offline || true
COPY . .
RUN ${bc.buildCommand || 'mvn -B -DskipTests package'}
RUN cp "$(ls target/*.jar | grep -v original | head -n1)" /app.jar

FROM eclipse-temurin:${v}-jre
WORKDIR /app
COPY --from=build /app.jar /app/app.jar
ENV SERVER_PORT=${port} PORT=${port}
EXPOSE ${port}
CMD ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/app.jar"]
`;
}

function gradle(bc: BuildConfig, port: number): string {
  const v = bc.javaVersion || '21';
  return `${header('java-gradle')}
FROM gradle:8-jdk${v} AS build
WORKDIR /src
COPY . .
RUN if [ -f gradlew ]; then chmod +x gradlew && ./gradlew bootJar --no-daemon || ./gradlew build -x test --no-daemon; else ${bc.buildCommand || 'gradle build -x test --no-daemon'}; fi
RUN cp "$(ls build/libs/*.jar | grep -v plain | head -n1)" /app.jar

FROM eclipse-temurin:${v}-jre
WORKDIR /app
COPY --from=build /app.jar /app/app.jar
ENV SERVER_PORT=${port} PORT=${port}
EXPOSE ${port}
CMD ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/app.jar"]
`;
}

function dotnet(bc: BuildConfig, port: number): string {
  const v = bc.dotnetVersion || `${DOTNET_DEFAULT}.0`;
  const proj = bc.dotnetProject || 'App.csproj';
  return `${header('dotnet')}
FROM mcr.microsoft.com/dotnet/sdk:${v} AS build
WORKDIR /src
COPY . .
RUN dotnet restore "${proj}"
RUN dotnet publish "${proj}" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:${v}
WORKDIR /app
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://+:${port} \\
    ASPNETCORE_HTTP_PORTS=${port}
EXPOSE ${port}
ENTRYPOINT ["dotnet", "${bc.entry || path.basename(proj, '.csproj') + '.dll'}"]
`;
}

function go(bc: BuildConfig, port: number): string {
  return `${header('go')}
FROM golang:${bc.goVersion || GO_DEFAULT}-alpine AS build
WORKDIR /src
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/app .

FROM ${ALPINE_IMAGE}
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=build /out/app /app/app
ENV PORT=${port}
EXPOSE ${port}
CMD ["/app/app"]
`;
}

function generic(port: number): string {
  return `${header('unknown')}
# No se detectó la tecnología. Complete este Dockerfile según su aplicación.
FROM ${ALPINE_IMAGE}
WORKDIR /app
COPY . .
EXPOSE ${port}
CMD ["sh", "-c", "echo 'Configure el Dockerfile de esta aplicación' && sleep infinity"]
`;
}

export function generateDockerfile(technology: string, bc: BuildConfig, internalPort: number): string {
  switch (technology) {
    case 'react': case 'vue': case 'angular': case 'svelte': return spa(technology, bc);
    case 'nextjs': case 'nuxt': case 'nestjs': case 'node': return nodeServer(technology, bc, internalPort);
    case 'static': return staticSite(bc);
    case 'python': case 'python-django': case 'python-flask': case 'python-fastapi': return python(technology, bc, internalPort);
    case 'php': case 'php-laravel': return php(technology, bc);
    case 'java-maven': return maven(bc, internalPort);
    case 'java-gradle': return gradle(bc, internalPort);
    case 'dotnet': return dotnet(bc, internalPort);
    case 'go': return go(bc, internalPort);
    default: return generic(internalPort);
  }
}

const NGINX_SPA = `server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    location / { try_files $uri $uri/ /index.html; }
    location ~* \\.(?:js|css|woff2?|png|jpg|jpeg|gif|svg|ico)$ { expires 7d; access_log off; }
}
`;
const NGINX_STATIC = NGINX_SPA.replace('/index.html; }', '=404; }');

const DOCKERIGNORE = `node_modules
.git
.gitignore
**/.DS_Store
**/__pycache__
.venv
venv
vendor
bin/Debug
obj
target
*.log
.env
.env.*
`;

/** Archivos auxiliares requeridos por las plantillas (se escriben en el código fuente). */
export function writeSupportFiles(sourceDir: string) {
  const ema = path.join(sourceDir, '.ema');
  fs.mkdirSync(ema, { recursive: true });
  fs.writeFileSync(path.join(ema, 'nginx-spa.conf'), NGINX_SPA);
  fs.writeFileSync(path.join(ema, 'nginx-static.conf'), NGINX_STATIC);
  const di = path.join(sourceDir, '.dockerignore');
  if (!fs.existsSync(di)) fs.writeFileSync(di, DOCKERIGNORE);
}
