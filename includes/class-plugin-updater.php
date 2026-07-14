<?php
/**
 * Native WordPress updates backed by reviewed GitHub release assets.
 */

if (! defined('ABSPATH')) {
    exit;
}

class ST_Sync_Plugin_Updater
{
    private const API_URL = 'https://api.github.com/repos/drivej/service-titan-job-posts/releases/latest';
    private const REPOSITORY_URL = 'https://github.com/drivej/service-titan-job-posts';
    private const PLUGIN_SLUG = 'service-titan-job-post';
    private const PACKAGE_NAME = 'service-titan-job-post.zip';
    private const CACHE_KEY = 'st_sync_github_release_v1';

    private bool $release_loaded = false;

    /** @var array|WP_Error|null */
    private $release;

    public function __construct()
    {
        add_filter('update_plugins_github.com', [$this, 'filter_plugin_update'], 10, 4);
        add_filter('plugins_api', [$this, 'filter_plugin_information'], 10, 3);
        add_filter('upgrader_pre_download', [$this, 'verify_package_download'], PHP_INT_MAX, 4);
    }

    public function filter_plugin_update($update, array $plugin_data, string $plugin_file, array $locales)
    {
        unset($locales);
        if (
            plugin_basename(ST_SYNC_PLUGIN_FILE) !== $plugin_file
            || self::REPOSITORY_URL !== (string) ($plugin_data['UpdateURI'] ?? '')
        ) {
            return $update;
        }

        $release = $this->latest_release();
        if (is_wp_error($release)) {
            return $update;
        }

        return [
            'slug'         => self::PLUGIN_SLUG,
            'version'      => $release['version'],
            'url'          => $release['release_url'],
            'package'      => $release['package_url'],
            'requires'     => '6.4',
            'requires_php' => '7.4',
            'tested'       => '7.0.1',
        ];
    }

    public function filter_plugin_information($result, string $action, $args)
    {
        $slug = is_object($args) ? (string) ($args->slug ?? '') : '';
        if ('plugin_information' !== $action || self::PLUGIN_SLUG !== $slug) {
            return $result;
        }

        $release = $this->latest_release();
        if (is_wp_error($release)) {
            return new WP_Error(
                'st_sync_update_metadata_unavailable',
                __('Update details are temporarily unavailable. Please try again later.', 'service-titan-job-post')
            );
        }

        $changelog = '' !== $release['notes']
            ? wpautop(esc_html($release['notes']))
            : '<p>' . esc_html__('See the GitHub release page for details.', 'service-titan-job-post') . '</p>';

        return (object) [
            'name'          => __('ServiceTitan Local Job Content', 'service-titan-job-post'),
            'slug'          => self::PLUGIN_SLUG,
            'version'       => $release['version'],
            'author'        => '<a href="https://github.com/drivej">Drive</a>',
            'homepage'      => self::REPOSITORY_URL,
            'requires'      => '6.4',
            'requires_php'  => '7.4',
            'tested'        => '7.0.1',
            'last_updated'  => $release['published_at'],
            'download_link' => $release['package_url'],
            'external'      => true,
            'sections'      => [
                'description' => '<p>' . esc_html__('Imports completed ServiceTitan jobs as reviewable, location-specific content.', 'service-titan-job-post') . '</p>',
                'changelog'   => $changelog,
            ],
        ];
    }

    public function verify_package_download($reply, string $package, $upgrader, array $hook_extra)
    {
        unset($upgrader);
        if (is_wp_error($reply)) {
            return $reply;
        }

        if (plugin_basename(ST_SYNC_PLUGIN_FILE) !== (string) ($hook_extra['plugin'] ?? '')) {
            return false;
        }

        if (! $this->is_allowed_package_url($package)) {
            return new WP_Error(
                'st_sync_invalid_update_package',
                __('The Local Job Content update package URL is invalid.', 'service-titan-job-post')
            );
        }

        $checksum_response = wp_safe_remote_get($package . '.sha256', [
            'timeout'             => 15,
            'redirection'         => 3,
            'limit_response_size' => 1024,
            'headers'             => ['User-Agent' => 'ServiceTitan-Local-Job-Content/' . ST_SYNC_VERSION],
        ]);
        if (
            is_wp_error($checksum_response)
            || 200 !== wp_remote_retrieve_response_code($checksum_response)
        ) {
            return new WP_Error(
                'st_sync_update_checksum_unavailable',
                __('The Local Job Content update checksum could not be downloaded.', 'service-titan-job-post')
            );
        }

        $owns_temporary_file = false;
        if (false === $reply) {
            if (! function_exists('download_url')) {
                require_once ABSPATH . 'wp-admin/includes/file.php';
            }
            $temporary_file = download_url($package, 300);
            if (is_wp_error($temporary_file)) {
                return $temporary_file;
            }
            $owns_temporary_file = true;
        } elseif (is_string($reply)) {
            $temporary_file = $reply;
        } else {
            return new WP_Error(
                'st_sync_invalid_pre_download_result',
                __('The Local Job Content update download could not be verified.', 'service-titan-job-post')
            );
        }

        $checksum = (string) wp_remote_retrieve_body($checksum_response);
        if (! $this->file_matches_checksum($temporary_file, $checksum)) {
            if ($owns_temporary_file) {
                wp_delete_file($temporary_file);
            }
            return new WP_Error(
                'st_sync_update_checksum_mismatch',
                __('The Local Job Content update failed its integrity check.', 'service-titan-job-post')
            );
        }

        return $temporary_file;
    }

    public function file_matches_checksum(string $file, string $checksum): bool
    {
        if (
            strlen($checksum) > 256
            || ! preg_match('/\A([a-f0-9]{64})[ \t]+\*?' . preg_quote(self::PACKAGE_NAME, '/') . '(?:\r?\n)?\z/i', $checksum, $matches)
            || ! is_file($file)
        ) {
            return false;
        }

        $actual = hash_file('sha256', $file);
        return is_string($actual) && hash_equals(strtolower($matches[1]), strtolower($actual));
    }

    /**
     * @return array|WP_Error
     */
    public function normalize_release(array $payload)
    {
        if (! empty($payload['draft']) || ! empty($payload['prerelease'])) {
            return new WP_Error('st_sync_unstable_release', 'Only stable releases can be installed.');
        }

        $tag = (string) ($payload['tag_name'] ?? '');
        if (! preg_match('/\Av([0-9]+\.[0-9]+\.[0-9]+)\z/', $tag, $matches)) {
            return new WP_Error('st_sync_invalid_release_tag', 'The release tag is invalid.');
        }
        $version = $matches[1];
        $expected_package = self::REPOSITORY_URL . '/releases/download/' . $tag . '/' . self::PACKAGE_NAME;
        $expected_checksum = $expected_package . '.sha256';
        $package_count = 0;
        $checksum_count = 0;

        foreach ((array) ($payload['assets'] ?? []) as $asset) {
            if (! is_array($asset)) {
                continue;
            }
            $name = (string) ($asset['name'] ?? '');
            $url = (string) ($asset['browser_download_url'] ?? '');
            if (self::PACKAGE_NAME === $name && $expected_package === $url) {
                ++$package_count;
            }
            if (self::PACKAGE_NAME . '.sha256' === $name && $expected_checksum === $url) {
                ++$checksum_count;
            }
        }

        if (1 !== $package_count || 1 !== $checksum_count) {
            return new WP_Error('st_sync_invalid_release_assets', 'The release assets are incomplete or invalid.');
        }

        $published_timestamp = strtotime((string) ($payload['published_at'] ?? ''));
        if (false === $published_timestamp) {
            return new WP_Error('st_sync_invalid_release_date', 'The release date is invalid.');
        }

        return [
            'version'      => $version,
            'tag'          => $tag,
            'release_url'  => self::REPOSITORY_URL . '/releases/tag/' . $tag,
            'package_url'  => $expected_package,
            'published_at' => gmdate('Y-m-d H:i:s', $published_timestamp),
            'notes'        => substr((string) ($payload['body'] ?? ''), 0, 20000),
        ];
    }

    private function latest_release()
    {
        if ($this->release_loaded) {
            return $this->release;
        }
        $this->release_loaded = true;

        $cached = get_site_transient(self::CACHE_KEY);
        if (is_array($cached) && 'ok' === ($cached['status'] ?? '') && is_array($cached['release'] ?? null)) {
            $this->release = $cached['release'];
            return $this->release;
        }
        if (is_array($cached) && 'error' === ($cached['status'] ?? '')) {
            $this->release = new WP_Error('st_sync_cached_update_error', 'Update metadata is temporarily unavailable.');
            return $this->release;
        }

        $response = wp_safe_remote_get(self::API_URL, [
            'timeout'     => 10,
            'redirection' => 3,
            'headers'     => [
                'Accept'     => 'application/vnd.github+json',
                'User-Agent' => 'ServiceTitan-Local-Job-Content/' . ST_SYNC_VERSION,
            ],
        ]);
        if (is_wp_error($response) || 200 !== wp_remote_retrieve_response_code($response)) {
            return $this->cache_release_error();
        }

        $payload = json_decode((string) wp_remote_retrieve_body($response), true);
        if (! is_array($payload)) {
            return $this->cache_release_error();
        }

        $release = $this->normalize_release($payload);
        if (is_wp_error($release)) {
            return $this->cache_release_error();
        }

        set_site_transient(self::CACHE_KEY, ['status' => 'ok', 'release' => $release], 6 * HOUR_IN_SECONDS);
        $this->release = $release;
        return $this->release;
    }

    private function cache_release_error(): WP_Error
    {
        set_site_transient(self::CACHE_KEY, ['status' => 'error'], 5 * MINUTE_IN_SECONDS);
        $this->release = new WP_Error('st_sync_update_metadata_unavailable', 'Update metadata is temporarily unavailable.');
        return $this->release;
    }

    private function is_allowed_package_url(string $package): bool
    {
        $parts = wp_parse_url($package);
        if (
            ! is_array($parts)
            || 'https' !== ($parts['scheme'] ?? '')
            || 'github.com' !== ($parts['host'] ?? '')
            || isset($parts['query'])
            || isset($parts['fragment'])
        ) {
            return false;
        }

        return 1 === preg_match(
            '#\A/drivej/service-titan-job-posts/releases/download/v[0-9]+\.[0-9]+\.[0-9]+/' . preg_quote(self::PACKAGE_NAME, '#') . '\z#',
            (string) ($parts['path'] ?? '')
        );
    }
}
