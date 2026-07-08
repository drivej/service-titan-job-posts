<?php
/**
 * Dynamic blocks for individual jobs and service/location pages.
 */

if (! defined('ABSPATH')) {
    exit;
}

class ST_Sync_Blocks
{
    public function __construct()
    {
        add_action('init', [$this, 'register_blocks']);
        add_shortcode('st_recent_jobs', [$this, 'recent_jobs_shortcode']);
        add_shortcode('service_titan_recent_jobs', [$this, 'recent_jobs_shortcode']);
    }

    public function register_blocks(): void
    {
        $blocks = [
            'job-details' => [$this, 'render_job_details'],
            'recent-jobs' => [$this, 'render_recent_jobs'],
        ];

        foreach ($blocks as $directory => $callback) {
            $path = ST_SYNC_PLUGIN_DIR . 'blocks/' . $directory;
            if (file_exists($path . '/block.json')) {
                register_block_type($path, ['render_callback' => $callback]);
            }
        }
    }

    public function render_job_details(array $attributes, string $content, WP_Block $block): string
    {
        unset($attributes, $content);
        $post_id = isset($block->context['postId'])
            ? (int) $block->context['postId']
            : (int) get_the_ID();

        if ('st_job' !== get_post_type($post_id)) {
            return '';
        }

        $summary = $this->public_summary($post_id);
        $city = (string) get_post_meta($post_id, 'st_job_city', true);
        $state = (string) get_post_meta($post_id, 'st_job_state', true);
        $service = (string) get_post_meta($post_id, 'st_job_service', true);
        $date = (string) get_post_meta($post_id, 'st_job_date', true);
        $location = implode(', ', array_filter([$city, $state]));
        $wrapper = get_block_wrapper_attributes(['class' => 'st-job-details']);

        ob_start();
        ?>
        <article <?php echo $wrapper; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>>
            <?php if ($service || $location) : ?>
                <p class="st-job-details__eyebrow">
                    <?php echo esc_html(implode(' in ', array_filter([$service, $location]))); ?>
                </p>
            <?php endif; ?>
            <?php if ($summary) : ?>
                <p class="st-job-details__summary"><?php echo esc_html($summary); ?></p>
            <?php endif; ?>
            <?php if ($date) : ?>
                <p class="st-job-details__date">
                    <?php esc_html_e('Completed', 'service-titan-job-post'); ?>
                    <time datetime="<?php echo esc_attr($date); ?>"><?php echo esc_html($this->format_date($date)); ?></time>
                </p>
            <?php endif; ?>
        </article>
        <?php
        if (! is_admin()) {
            echo $this->json_ld_script($this->job_schema($post_id)); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
        }
        return (string) ob_get_clean();
    }

    public function render_recent_jobs(array $attributes, string $content, ?WP_Block $block = null): string
    {
        unset($content);
        $context = $this->resolve_service_location($attributes, $block);
        if ('' === $context['service'] || '' === $context['location']) {
            return $this->editor_notice(__('Choose a service and location, or place this block on a nested service/location page.', 'service-titan-job-post'));
        }

        $options = wp_parse_args(get_option('st_sync_options', []), ST_Sync_Admin::defaults());
        $default_count = (int) $options['recent_jobs_count'];
        $requested_count = (int) ($attributes['jobsToShow'] ?? 0);
        $count = $requested_count > 0
            ? min(12, $requested_count)
            : min(12, max(1, $default_count));

        $query = new WP_Query([
            'post_type'              => 'st_job',
            'post_status'            => 'publish',
            'posts_per_page'         => $count,
            'meta_key'               => 'st_job_date',
            'orderby'                => 'meta_value',
            'order'                  => 'DESC',
            'no_found_rows'          => true,
            'update_post_meta_cache' => true,
            'tax_query'              => [
                'relation' => 'AND',
                [
                    'taxonomy' => 'st_service',
                    'field'    => 'slug',
                    'terms'    => $context['service'],
                ],
                [
                    'taxonomy' => 'st_location',
                    'field'    => 'slug',
                    'terms'    => $context['location'],
                ],
            ],
        ]);

        if (! $query->have_posts()) {
            return $this->editor_notice(__('No approved jobs match this service and location yet.', 'service-titan-job-post'));
        }

        $service_term = get_term_by('slug', $context['service'], 'st_service');
        $location_term = get_term_by('slug', $context['location'], 'st_location');
        $service_name = $service_term ? $service_term->name : ucwords(str_replace('-', ' ', $context['service']));
        $location_name = $location_term ? $location_term->name : ucwords(str_replace('-', ' ', $context['location']));
        $heading = trim((string) ($attributes['heading'] ?? ''));
        if ('' === $heading) {
            $heading = sprintf(
                __('Recent %1$s work in %2$s', 'service-titan-job-post'),
                $service_name,
                $location_name
            );
        }

        $wrapper_attributes = [
            'class' => 'st-recent-jobs',
            'data-service' => $context['service'],
            'data-location' => $context['location'],
        ];
        $wrapper = $block
            ? get_block_wrapper_attributes($wrapper_attributes)
            : $this->html_attributes($wrapper_attributes);
        $heading_id = ! empty($attributes['anchor'])
            ? sanitize_title((string) $attributes['anchor']) . '-heading'
            : wp_unique_id('st-recent-jobs-heading-');

        ob_start();
        $schemas = [];
        $position = 1;
        ?>
        <section <?php echo $wrapper; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?> aria-labelledby="<?php echo esc_attr($heading_id); ?>">
            <h2 id="<?php echo esc_attr($heading_id); ?>" class="st-recent-jobs__heading"><?php echo esc_html($heading); ?></h2>
            <div class="st-recent-jobs__grid">
                <?php while ($query->have_posts()) : $query->the_post(); ?>
                    <?php
                    $job_id = (int) get_the_ID();
                    $summary = $this->public_summary($job_id);
                    $date = (string) get_post_meta($job_id, 'st_job_date', true);
                    $schemas[] = [
                        '@type'    => 'ListItem',
                        'position' => $position,
                        'url'      => get_permalink($job_id),
                        'item'     => $this->job_schema($job_id, false),
                    ];
                    $position++;
                    ?>
                    <article class="st-recent-jobs__card">
                        <h3 class="st-recent-jobs__title">
                            <a href="<?php echo esc_url(get_permalink($job_id)); ?>"><?php echo esc_html(get_the_title($job_id)); ?></a>
                        </h3>
                        <?php if ($summary) : ?>
                            <p class="st-recent-jobs__summary"><?php echo esc_html($summary); ?></p>
                        <?php endif; ?>
                        <?php if ($date) : ?>
                            <p class="st-recent-jobs__date">
                                <time datetime="<?php echo esc_attr($date); ?>"><?php echo esc_html($this->format_date($date)); ?></time>
                            </p>
                        <?php endif; ?>
                    </article>
                <?php endwhile; ?>
            </div>
            <?php
            if (! is_admin()) {
                echo $this->json_ld_script([
                    '@context' => 'https://schema.org',
                    '@type'    => 'ItemList',
                    'name'     => $heading,
                    'itemListElement' => $schemas,
                ]); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
            }
            ?>
        </section>
        <?php
        wp_reset_postdata();

        return (string) ob_get_clean();
    }

    public function recent_jobs_shortcode($attributes = []): string
    {
        $attributes = shortcode_atts([
            'service'      => '',
            'service_slug' => '',
            'location'     => '',
            'location_slug'=> '',
            'count'        => '',
            'heading'      => '',
        ], is_array($attributes) ? $attributes : [], 'st_recent_jobs');

        return $this->render_recent_jobs([
            'serviceSlug'  => $attributes['service_slug'] ?: $attributes['service'],
            'locationSlug' => $attributes['location_slug'] ?: $attributes['location'],
            'jobsToShow'   => (int) $attributes['count'],
            'heading'      => (string) $attributes['heading'],
        ], '', null);
    }

    private function resolve_service_location(array $attributes, ?WP_Block $block = null): array
    {
        $service = sanitize_title((string) ($attributes['serviceSlug'] ?? ''));
        $location = sanitize_title((string) ($attributes['locationSlug'] ?? ''));

        if ($service && $location) {
            return compact('service', 'location');
        }

        $post_id = $block && isset($block->context['postId'])
            ? (int) $block->context['postId']
            : (int) get_queried_object_id();
        $page = get_post($post_id);

        if ($page instanceof WP_Post) {
            $location = $location ?: $page->post_name;
            if (! $service && $page->post_parent) {
                $parent = get_post($page->post_parent);
                $service = $parent instanceof WP_Post ? $parent->post_name : '';
            }

            if (! $service) {
                $path = trim((string) wp_parse_url(get_permalink($page), PHP_URL_PATH), '/');
                $segments = array_values(array_filter(explode('/', $path)));
                if (count($segments) >= 2) {
                    $service = sanitize_title($segments[count($segments) - 2]);
                    $location = sanitize_title($segments[count($segments) - 1]);
                }
            }
        }

        return compact('service', 'location');
    }

    private function format_date(string $date): string
    {
        $timestamp = strtotime($date);
        return false === $timestamp
            ? $date
            : wp_date(get_option('date_format'), $timestamp);
    }

    private function public_summary(int $post_id): string
    {
        $excerpt = trim((string) get_post_field('post_excerpt', $post_id));
        if ('' !== $excerpt) {
            return wp_trim_words(wp_strip_all_tags($excerpt), 55);
        }

        $content = trim((string) get_post_field('post_content', $post_id));
        if ('' !== $content) {
            $plain = wp_strip_all_tags(strip_shortcodes($content));
            $plain = html_entity_decode($plain, ENT_QUOTES, get_bloginfo('charset') ?: 'UTF-8');
            return wp_trim_words($plain, 55);
        }

        return '';
    }

    private function job_schema(int $post_id, bool $include_context = true): array
    {
        $url = get_permalink($post_id);
        $city = (string) get_post_meta($post_id, 'st_job_city', true);
        $state = (string) get_post_meta($post_id, 'st_job_state', true);
        $service = (string) get_post_meta($post_id, 'st_job_service', true);
        $job_type = (string) get_post_meta($post_id, 'st_job_type_name', true);
        $summary = $this->public_summary($post_id);
        $completed_on = (string) get_post_meta($post_id, 'st_job_date', true);
        $schema = [
            '@type'            => 'Service',
            '@id'              => untrailingslashit($url) . '#service',
            'url'              => $url,
            'name'             => get_the_title($post_id),
            'description'      => $summary,
            'serviceType'      => $service ?: $job_type,
            'provider'         => [
                '@type' => 'LocalBusiness',
                'name'  => get_bloginfo('name'),
                'url'   => home_url('/'),
            ],
            'areaServed'       => [
                '@type'   => 'Place',
                'name'    => trim(implode(', ', array_filter([$city, $state]))),
                'address' => [
                    '@type'           => 'PostalAddress',
                    'addressLocality' => $city,
                    'addressRegion'   => $state,
                ],
            ],
            'datePublished'    => get_post_time('c', true, $post_id),
            'dateModified'     => get_post_modified_time('c', true, $post_id),
            'mainEntityOfPage' => $url,
        ];

        if ('' !== $completed_on) {
            $schema['serviceOutput'] = sprintf(
                /* translators: %s: completed date */
                __('Completed service on %s', 'service-titan-job-post'),
                $this->format_date($completed_on)
            );
        }

        if ($include_context) {
            $schema = ['@context' => 'https://schema.org'] + $schema;
        }

        return $this->prune_schema($schema);
    }

    private function json_ld_script(array $data): string
    {
        $json = wp_json_encode(
            $data,
            JSON_UNESCAPED_SLASHES |
            JSON_UNESCAPED_UNICODE |
            JSON_HEX_TAG |
            JSON_HEX_AMP |
            JSON_HEX_APOS |
            JSON_HEX_QUOT
        );
        if (! $json) {
            return '';
        }

        return '<script type="application/ld+json">' . $json . '</script>';
    }

    private function html_attributes(array $attributes): string
    {
        $pairs = [];
        foreach ($attributes as $key => $value) {
            if ('' === (string) $value) {
                continue;
            }
            $pairs[] = esc_attr((string) $key) . '="' . esc_attr((string) $value) . '"';
        }

        return implode(' ', $pairs);
    }

    private function prune_schema(array $data): array
    {
        foreach ($data as $key => $value) {
            if (is_array($value)) {
                $value = $this->prune_schema($value);
            }

            if ('' === $value || null === $value || (is_array($value) && empty($value))) {
                unset($data[$key]);
                continue;
            }

            $data[$key] = $value;
        }

        return $data;
    }

    private function editor_notice(string $message): string
    {
        if (! is_admin() && ! current_user_can('edit_posts')) {
            return '';
        }

        return '<p class="st-recent-jobs__notice">' . esc_html($message) . '</p>';
    }
}
