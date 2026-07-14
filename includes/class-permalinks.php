<?php
/**
 * Builds job permalinks beneath the matching service/location path.
 */

if (! defined('ABSPATH')) {
    exit;
}

class ST_Sync_Permalinks
{
    public function __construct()
    {
        add_action('init', [$this, 'register_rewrite_rules']);
        add_filter('post_type_link', [$this, 'filter_job_link'], 10, 2);
    }

    public function register_rewrite_rules(): void
    {
        add_rewrite_rule(
            '^([^/]+)/([^/]+)/job/([^/]+)/?$',
            'index.php?post_type=st_job&name=$matches[3]',
            'top'
        );
    }

    public function filter_job_link(string $link, WP_Post $post): string
    {
        if ('st_job' !== $post->post_type) {
            return $link;
        }

        $service = $this->first_term_slug($post->ID, 'st_service', 'service');
        $location = $this->first_term_slug($post->ID, 'st_location', 'location');

        return home_url(
            user_trailingslashit(
                $service . '/' . $location . '/job/' . $post->post_name
            )
        );
    }

    private function first_term_slug(int $post_id, string $taxonomy, string $fallback): string
    {
        $terms = wp_get_post_terms($post_id, $taxonomy);

        if (is_wp_error($terms) || empty($terms)) {
            return $fallback;
        }

        return $terms[0]->slug;
    }
}
