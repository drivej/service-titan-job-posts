<?php
    /**
 * Handles the registration and rendering of Gutenberg blocks.
 */

    if (! defined('ABSPATH')) {
    exit;
    }

    class ST_Sync_Blocks
    {

    public function __construct()
    {
        // Register the block on initialization
        add_action('init', [$this, 'register_job_details_block']);
    }

    /**
     * Register the block using the metadata from block.json
     */
    public function register_job_details_block(): void
    {
        // Path to the folder containing your block.json
        $block_path = plugin_dir_path(__DIR__) . 'blocks/job-details';

        if (file_exists($block_path . '/block.json')) {
            register_block_type($block_path, [
                'render_callback' => [$this, 'render_job_details'],
            ]);
        }
    }

    /**
     * Dynamic render callback for the front-end
     */
    public function render_job_details(array $attributes, string $content, WP_Block $block): string
    {
        $post_id = isset($block->context['postId'])
            ? (int) $block->context['postId']
            : get_the_ID();

        // These keys should match what Sevalla pushes to the WP REST API
        $price = get_post_meta($post_id, 'st_job_price', true);
        $date  = get_post_meta($post_id, 'st_job_date', true);

        // Return the HTML for the front-end
        ob_start();
        ?>
<style>
    .st-job-card {
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.08); /* Modern subtle shadow */
        padding: 24px;
        border: 1px solid #f0f0f0;
        max-width: 400px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .st-job-card h3 { margin: 0 0 16px 0; color: #1a1a1a; font-size: 1.25rem; }
    .st-job-price { font-size: 1.5rem; font-weight: 700; color: #2ecc71; margin-bottom: 8px; }
    .st-job-date { color: #666; font-size: 0.9rem; }
</style>
<div class="st-job-card">
    <h3>ServiceTitan Job</h3>
    <div class="st-job-price">$<?php echo esc_html(number_format((float) $price, 2)); ?></div>
    <div class="st-job-date">Completed: <?php echo esc_html($date); ?></div>
</div>
        <?php
            return ob_get_clean();
                }
            }

            // Initialize the class
        new ST_Sync_Blocks();
