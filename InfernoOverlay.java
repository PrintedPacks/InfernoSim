package net.runelite.client.plugins.runevision.inferno;

import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.awt.Polygon;
import javax.inject.Inject;
import net.runelite.api.Client;
import net.runelite.api.Perspective;
import net.runelite.api.Player;
import net.runelite.api.Point;
import net.runelite.api.coords.LocalPoint;
import net.runelite.api.coords.WorldPoint;
import net.runelite.client.plugins.runevision.util.coords.Rs2LocalPoint;
import net.runelite.client.ui.overlay.Overlay;
import net.runelite.client.ui.overlay.OverlayLayer;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.ui.overlay.OverlayUtil;

/**
 * Draws a square of tiles centred on the player, for reading positions off the
 * screen while working out where the script should stand.
 */
public class InfernoOverlay extends Overlay
{
	/** 21 tiles across, so ten either side of the player. */
	private static final int RADIUS = 10;

	/** The arena floor. Tiles outside this are not worth scoring or drawing. */
	private static final WorldPoint ARENA_SW = new WorldPoint(2257, 5329, 0);
	private static final WorldPoint ARENA_NE = new WorldPoint(2285, 5358, 0);

	private static final Color GRID_COLOUR = new Color(255, 255, 255, 60);
	private static final Color CENTRE_COLOUR = new Color(0, 255, 255, 140);
	private static final Color SCORE_COLOUR = new Color(255, 255, 255, 170);

	private final Client client;
	private final InfernoPlugin plugin;

	@Inject
	InfernoOverlay(Client client, InfernoPlugin plugin)
	{
		this.client = client;
		this.plugin = plugin;
		setPosition(OverlayPosition.DYNAMIC);
		setLayer(OverlayLayer.ABOVE_SCENE);
	}

	@Override
	public Dimension render(Graphics2D graphics)
	{
		if (!plugin.isGridEnabled())
		{
			return null;
		}

		Player player = client.getLocalPlayer();
		if (player == null)
		{
			return null;
		}

		LocalPoint centre = player.getLocalLocation();
		if (centre == null)
		{
			return null;
		}

		// The arena corners resolved into local space, rather than converting every
		// tile back to world space. One conversion instead of 441, and it sidesteps
		// the instance question entirely -- whatever rotation the instance applies,
		// both corners go through it the same way the walker's targets do.
		LocalPoint swCorner = toLocal(ARENA_SW);
		LocalPoint neCorner = toLocal(ARENA_NE);
		if (swCorner == null || neCorner == null)
		{
			// Not in the arena, or it is not loaded.
			return null;
		}

		// Min/max rather than assuming SW is the lower corner: the instance can flip
		// the map, so south-west in the world is not necessarily lowest in local space.
		int minX = Math.min(swCorner.getX(), neCorner.getX());
		int maxX = Math.max(swCorner.getX(), neCorner.getX());
		int minY = Math.min(swCorner.getY(), neCorner.getY());
		int maxY = Math.max(swCorner.getY(), neCorner.getY());

		for (int dx = -RADIUS; dx <= RADIUS; dx++)
		{
			for (int dy = -RADIUS; dy <= RADIUS; dy++)
			{
				// Local coordinates are scene-relative, so stepping by a tile works
				// inside an instance as well as out in the world.
				LocalPoint tile = new LocalPoint(
					centre.getX() + (dx * Perspective.LOCAL_TILE_SIZE),
					centre.getY() + (dy * Perspective.LOCAL_TILE_SIZE),
					client.getTopLevelWorldView());

				if (tile.getX() < minX || tile.getX() > maxX
					|| tile.getY() < minY || tile.getY() > maxY)
				{
					// Outside the arena floor.
					continue;
				}

				Polygon poly = Perspective.getCanvasTilePoly(client, tile);
				if (poly == null)
				{
					// Off screen or outside the loaded scene.
					continue;
				}

				graphics.setColor(dx == 0 && dy == 0 ? CENTRE_COLOUR : GRID_COLOUR);
				graphics.draw(poly);

				String label = String.valueOf(score(dx, dy));
				Point text = Perspective.getCanvasTextLocation(client, graphics, tile, label, 0);
				if (text != null)
				{
					OverlayUtil.renderTextLocation(graphics, text, label, SCORE_COLOUR);
				}
			}
		}

		return null;
	}

	/**
	 * Resolved the same way the walker resolves its targets: the plain conversion
	 * returns null inside an instance, and the Inferno is one, so the instance form
	 * is the branch that actually runs here.
	 */
	private LocalPoint toLocal(WorldPoint worldPoint)
	{
		LocalPoint local = LocalPoint.fromWorld(client.getTopLevelWorldView(), worldPoint);
		if (local == null && client.getTopLevelWorldView().isInstance())
		{
			local = Rs2LocalPoint.fromWorldInstance(worldPoint);
		}

		return local;
	}

	/**
	 * The number drawn on a tile, offset from the player in tiles.
	 *
	 * <p>Flat zero for now -- this is the hook the real positioning score goes
	 * behind, so the grid can show what the script thinks of each tile without the
	 * overlay needing to change.</p>
	 */
	private int score(int dx, int dy)
	{
		return 0;
	}
}
